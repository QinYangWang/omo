package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
	"github.com/caelis-labs/acp-go-sdk/transport/stdio"
)

const (
	eventBufferSize          = 256
	diagnosticLimit          = 2000
	rawDiagnosticSize        = 4096
	stderrLimit              = 64 << 10
	textBatchDelay           = 20 * time.Millisecond
	defaultPermissionTimeout = 5 * time.Minute
	cancelResponseTimeout    = 2 * time.Second
)

// Manager owns one process, one ACP session, and at most one active turn.
type Manager struct {
	lifecycle sync.Mutex
	mu        sync.Mutex

	state           State
	sessionID       string
	canLoad         bool
	peer            *peer
	startingCancel  context.CancelFunc
	generation      uint64
	active          bool
	cancelRequested bool
	turn            uint64
	turnCancel      context.CancelFunc
	dispatchDone    chan struct{}

	pending           map[string]*pendingPermission
	nextRequest       uint64
	diagnostics       []string
	events            chan Event
	permissionTimeout time.Duration
	batchMu           sync.Mutex
	batch             *textBatch
	batchTimer        *time.Timer
}

type peer struct {
	manager    *Manager
	generation uint64
	cwd        string
	conn       *acp.Connection
	proc       *stdio.Process
	stderr     *tailWriter
	stopping   atomic.Bool
}

type pendingPermission struct {
	peer       *peer
	generation uint64
	turn       uint64
	toolCallID string
	options    map[string]struct{}
	rejectID   string
	result     chan permissionResult
}

type permissionResult struct {
	optionID string
	cancel   bool
}

type textBatch struct {
	peer       *peer
	generation uint64
	turn       uint64
	kind       EventKind
	messageID  string
	text       string
}

func NewManager() *Manager {
	return &Manager{
		state:             StateDisconnected,
		pending:           make(map[string]*pendingPermission),
		events:            make(chan Event, eventBufferSize),
		permissionTimeout: defaultPermissionTimeout,
	}
}

// Events returns the bounded normalized stream. Text and thoughts are coalesced.
func (m *Manager) Events() <-chan Event { return m.events }

func (m *Manager) Start(ctx context.Context, def Definition, cwd string) error {
	m.lifecycle.Lock()
	defer m.lifecycle.Unlock()
	m.mu.Lock()
	busy := m.active
	started := m.peer != nil
	m.mu.Unlock()
	if busy {
		return ErrBusy
	}
	if started {
		return ErrAlreadyStarted
	}
	ctx, done := m.startOperation(ctx)
	defer done()
	return m.start(ctx, def, cwd, "")
}

func (m *Manager) Restart(ctx context.Context, def Definition, cwd string) error {
	m.lifecycle.Lock()
	defer m.lifecycle.Unlock()
	ctx, done := m.startOperation(ctx)
	defer done()
	m.flushText()
	m.mu.Lock()
	if m.active {
		m.mu.Unlock()
		return ErrBusy
	}
	if _, err := VerifyTrusted(def); err != nil {
		m.mu.Unlock()
		return err
	}
	oldSession := m.sessionID
	oldPeer := m.peer
	m.peer = nil
	m.mu.Unlock()
	if oldPeer != nil {
		if err := m.closePeer(ctx, oldPeer); err != nil {
			m.fail(startError(err, "close previous agent"))
			return err
		}
		m.setState(StateDisconnected)
	}
	return m.start(ctx, def, cwd, oldSession)
}

func (m *Manager) start(ctx context.Context, def Definition, cwd, restoreID string) error {
	executable, err := VerifyTrusted(def)
	if err != nil {
		return err
	}
	cwd, err = filepath.Abs(cwd)
	if err != nil {
		return fmt.Errorf("agent: cwd: %w", err)
	}
	m.flushText()
	m.setState(StateStarting)
	m.mu.Lock()
	m.generation++
	generation := m.generation
	m.sessionID = restoreID
	m.canLoad = false
	m.cancelRequested = false
	m.mu.Unlock()

	stderr := &tailWriter{limit: stderrLimit}
	proc, err := stdio.Start(context.WithoutCancel(ctx), stdio.Command{
		Executable: executable,
		Args:       append([]string(nil), def.Args...),
		Dir:        cwd,
		Env:        minimalEnv(def.Env),
		Stderr:     stderr,
	})
	if err != nil {
		m.fail(fmt.Errorf("start agent: %w", err))
		return err
	}
	p := &peer{manager: m, generation: generation, cwd: cwd, proc: proc, stderr: stderr}
	conn, err := acp.NewConnectionWithOptions(p.handle, proc.Input(), proc.Output(), acp.ConnectionOptions{})
	if err != nil {
		p.stopping.Store(true)
		_ = proc.Close()
		m.fail(fmt.Errorf("open ACP connection: %w", err))
		return err
	}
	p.conn = conn
	m.mu.Lock()
	m.peer = p
	m.mu.Unlock()
	go m.watch(p)

	init, err := acp.SendRequest[acp.InitializeResponse](conn, ctx, acp.AgentMethodInitialize, acp.InitializeRequest{
		ProtocolVersion: acp.WireProtocolVersion,
		ClientInfo:      &acp.Implementation{Name: "omo", Version: "p2"},
		ClientCapabilities: acp.ClientCapabilities{
			Fs:       acp.FileSystemCapabilities{ReadTextFile: false, WriteTextFile: false},
			Terminal: false,
		},
	})
	if err != nil {
		m.abortStart(p, fmt.Errorf("initialize ACP: %w", err))
		return err
	}
	if init.ProtocolVersion != acp.WireProtocolVersion {
		err := fmt.Errorf("agent: unsupported ACP protocol version %d", init.ProtocolVersion)
		m.abortStart(p, err)
		return err
	}
	m.mu.Lock()
	if m.peer != p {
		m.mu.Unlock()
		return ErrTurnUnknown
	}
	m.canLoad = init.AgentCapabilities.LoadSession
	canLoad := m.canLoad
	m.mu.Unlock()

	if restoreID != "" && canLoad {
		_, err = acp.SendRequest[acp.LoadSessionResponse](conn, ctx, acp.AgentMethodSessionLoad, acp.LoadSessionRequest{
			SessionId:  acp.SessionId(restoreID),
			Cwd:        cwd,
			McpServers: []acp.McpServer{},
		})
		if err != nil {
			m.abortStart(p, fmt.Errorf("load ACP session: %w", err))
			return err
		}
		m.diagnose("restored ACP session "+restoreID, "")
	} else {
		replacement := ""
		if restoreID != "" {
			replacement = "agent does not advertise loadSession; created a new session instead of restoring " + restoreID
		}
		created, createErr := acp.SendRequest[acp.NewSessionResponse](conn, ctx, acp.AgentMethodSessionNew, acp.NewSessionRequest{
			Cwd:        cwd,
			McpServers: []acp.McpServer{},
		})
		if createErr != nil {
			m.abortStart(p, createErr)
			return createErr
		}
		if created.SessionId == "" {
			err := errors.New("agent: session/new returned an empty session id")
			m.abortStart(p, err)
			return err
		}
		m.mu.Lock()
		m.sessionID = string(created.SessionId)
		m.mu.Unlock()
		if replacement != "" {
			m.diagnose(replacement, "")
			m.emit(Event{Kind: EventSessionReplaced, Generation: generation, Text: replacement})
		}
	}
	m.mu.Lock()
	connected := m.peer == p && conn.Err() == nil
	m.mu.Unlock()
	if !connected {
		return ErrTurnUnknown
	}
	m.flushText()
	m.setState(StateReady)
	return nil
}

func (m *Manager) Prompt(ctx context.Context, text string) error {
	m.flushText()
	m.mu.Lock()
	if m.active {
		m.mu.Unlock()
		return ErrBusy
	}
	if m.state != StateReady || m.peer == nil || m.sessionID == "" {
		m.mu.Unlock()
		return ErrNotReady
	}
	p := m.peer
	sessionID := m.sessionID
	// Prepared dispatch lets Cancel wait until the prompt is written before cancelling it.
	req, err := acp.PrepareRequest[acp.PromptResponse](p.conn, acp.AgentMethodSessionPrompt, acp.PromptRequest{
		SessionId: acp.SessionId(sessionID),
		Prompt:    []acp.ContentBlock{acp.TextBlock(text)},
	})
	if err != nil {
		m.mu.Unlock()
		return err
	}
	turnCtx, turnCancel := context.WithCancel(ctx)
	defer turnCancel()
	m.active = true
	m.cancelRequested = false
	m.turn++
	turn := m.turn
	m.turnCancel = turnCancel
	m.dispatchDone = make(chan struct{})
	dispatchDone := m.dispatchDone
	m.state = StatePrompting
	m.mu.Unlock()
	m.emit(Event{Kind: EventState, State: StatePrompting, Generation: p.generation, Turn: turn})

	dispatchErr := req.Dispatch(turnCtx, acp.DispatchOptions{})
	close(dispatchDone)
	response, waitErr := req.Wait(turnCtx)
	requestErr := dispatchErr
	if requestErr == nil {
		requestErr = waitErr
	}
	if waitErr != nil && ctx.Err() != nil {
		m.mu.Lock()
		needCancel := m.active && m.turn == turn && !m.cancelRequested
		m.mu.Unlock()
		if needCancel {
			cancelCtx, cancel := context.WithTimeout(context.Background(), cancelResponseTimeout)
			_ = m.Cancel(cancelCtx)
			cancel()
		}
	}
	m.mu.Lock()
	cancelling := m.active && m.turn == turn && m.cancelRequested
	m.mu.Unlock()
	if cancelling && requestErr != nil {
		if dispatchErr != nil {
			if acp.RequestMayHaveBeenSubmitted(dispatchErr) {
				m.abortPrompt(p, turn)
			}
		} else {
			waitCtx, cancel := context.WithTimeout(context.Background(), cancelResponseTimeout)
			response, waitErr = req.Wait(waitCtx)
			requestErr = waitErr
			if waitCtx.Err() != nil {
				m.abortPrompt(p, turn)
				requestErr = fmt.Errorf("agent: cancellation response: %w", waitCtx.Err())
			}
			cancel()
		}
	}
	return m.finishPrompt(p, turn, response.StopReason, requestErr)
}

func (m *Manager) abortPrompt(p *peer, turn uint64) {
	m.mu.Lock()
	current := m.peer == p && m.active && m.turn == turn
	m.mu.Unlock()
	if !current {
		return
	}
	p.stopping.Store(true)
	m.cancelPermissions(p)
	_ = p.proc.Close()
	_ = p.conn.Close()
}

func (m *Manager) finishPrompt(p *peer, turn uint64, stopReason acp.StopReason, requestErr error) error {
	m.flushText()
	m.mu.Lock()
	if m.turn != turn {
		m.mu.Unlock()
		return ErrTurnUnknown
	}
	m.active = false
	m.turnCancel = nil
	m.dispatchDone = nil
	cancelled := m.cancelRequested
	connected := m.peer == p && !p.stopping.Load() && p.conn.Err() == nil
	reason := string(stopReason)
	result := requestErr
	nextState := m.state
	connectionLost := false
	if requestErr != nil {
		switch {
		case !connected:
			reason = "unknown"
			result = fmt.Errorf("%w: %v", ErrTurnUnknown, requestErr)
			if m.peer == p {
				m.peer = nil
				nextState = StateError
				connectionLost = true
			}
		case cancelled || errors.Is(requestErr, context.Canceled) || errors.Is(requestErr, context.DeadlineExceeded):
			reason = string(acp.StopReasonCancelled)
			nextState = StateReady
		default:
			reason = "unknown"
			nextState = StateReady
		}
	} else if connected {
		nextState = StateReady
	}
	m.cancelRequested = false
	m.state = nextState
	m.mu.Unlock()

	if connectionLost {
		m.diagnose("ACP connection lost: "+errorString(p.conn.Err()), p.stderr.String())
	}
	m.emit(Event{Kind: EventTurnEnd, State: nextState, Generation: p.generation, Turn: turn, StopReason: reason})
	if nextState == StateReady || nextState == StateError {
		m.emit(Event{Kind: EventState, State: nextState, Generation: p.generation, Turn: turn})
	}
	if requestErr != nil && connected && !cancelled {
		m.diagnose("prompt failed: "+requestErr.Error(), "")
	}
	return result
}

func (m *Manager) Cancel(ctx context.Context) error {
	m.flushText()
	m.mu.Lock()
	if !m.active || m.peer == nil || m.sessionID == "" {
		m.mu.Unlock()
		return ErrNotReady
	}
	p := m.peer
	sessionID := m.sessionID
	dispatchDone := m.dispatchDone
	turn := m.turn
	turnCancel := m.turnCancel
	firstCancel := !m.cancelRequested
	if firstCancel {
		m.cancelRequested = true
		m.state = StateCancelling
	}
	m.mu.Unlock()
	if firstCancel {
		m.cancelPermissions(p)
		m.emit(Event{Kind: EventState, State: StateCancelling, Generation: p.generation, Turn: turn})
	}
	if dispatchDone != nil {
		timer := time.NewTimer(cancelResponseTimeout)
		defer timer.Stop()
		select {
		case <-dispatchDone:
		case <-ctx.Done():
			if turnCancel != nil {
				turnCancel()
			}
			return context.Cause(ctx)
		case <-timer.C:
			if turnCancel != nil {
				turnCancel()
			}
			return ErrTurnUnknown
		}
	}
	sendCtx, cancel := context.WithTimeout(ctx, cancelResponseTimeout)
	err := p.conn.SendNotification(sendCtx, acp.AgentMethodSessionCancel, acp.CancelNotification{SessionId: acp.SessionId(sessionID)})
	cancel()
	// Let the local wait proceed only after session/cancel reached the writer.
	if turnCancel != nil {
		turnCancel()
	}
	return err
}

// Resolve resolves one pending request exactly once and only with an advertised option.
func (m *Manager) Resolve(requestID, optionID string) bool {
	m.mu.Lock()
	pending, ok := m.pending[requestID]
	if !ok {
		m.mu.Unlock()
		return false
	}
	if _, ok := pending.options[optionID]; !ok {
		m.mu.Unlock()
		return false
	}
	m.mu.Unlock()
	return m.completePermission(requestID, pending, permissionResult{optionID: optionID})
}

func (m *Manager) Close(ctx context.Context) error {
	m.mu.Lock()
	cancelStart := m.startingCancel
	m.mu.Unlock()
	if cancelStart != nil {
		cancelStart()
	}
	m.lifecycle.Lock()
	defer m.lifecycle.Unlock()
	m.flushText()
	m.mu.Lock()
	p := m.peer
	m.peer = nil
	m.canLoad = false
	m.state = StateDisconnected
	m.mu.Unlock()
	if p != nil {
		p.stopping.Store(true)
		m.cancelPermissions(p)
	}
	m.emit(Event{Kind: EventState, State: StateDisconnected})
	if p == nil {
		return nil
	}
	return m.shutdownPeer(ctx, p)
}

// startOperation lets Close cancel a peer that never answers initialize.
// lifecycle guarantees at most one starting operation at a time.
func (m *Manager) startOperation(ctx context.Context) (context.Context, func()) {
	ctx, cancel := context.WithCancel(ctx)
	m.mu.Lock()
	m.startingCancel = cancel
	m.mu.Unlock()
	return ctx, func() {
		cancel()
		m.mu.Lock()
		m.startingCancel = nil
		m.mu.Unlock()
	}
}

func (m *Manager) Snapshot() (State, string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state, m.sessionID, m.canLoad
}

func (m *Manager) Diagnostics() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.diagnostics...)
}

func (m *Manager) watch(p *peer) {
	<-p.conn.Done()
	if p.stopping.Load() {
		return
	}
	// A protocol failure can close the connection while the child is still alive.
	defer p.proc.Close()
	m.mu.Lock()
	if m.peer != p || p.stopping.Load() {
		m.mu.Unlock()
		return
	}
	m.peer = nil
	m.state = StateError
	m.mu.Unlock()
	m.cancelPermissions(p)
	m.diagnose("ACP connection lost: "+errorString(p.conn.Err()), p.stderr.String())
	m.emit(Event{Kind: EventState, State: StateError})
}

func (m *Manager) abortStart(p *peer, cause error) {
	m.diagnose(cause.Error(), p.stderr.String())
	p.stopping.Store(true)
	m.cancelPermissions(p)
	m.mu.Lock()
	if m.peer == p {
		m.peer = nil
	}
	m.mu.Unlock()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	_ = m.shutdownPeer(shutdownCtx, p)
	cancel()
	m.setState(StateError)
}

func (m *Manager) closePeer(ctx context.Context, p *peer) error {
	p.stopping.Store(true)
	m.cancelPermissions(p)
	return m.shutdownPeer(ctx, p)
}

func (m *Manager) shutdownPeer(ctx context.Context, p *peer) error {
	// Terminate and join the child before closing our read stream. On Windows,
	// closing that stream first can wait on a read owned by the live child.
	err := p.proc.Shutdown(ctx)
	_ = p.conn.Close()
	if errors.Is(err, acp.ErrConnectionClosed) || errors.Is(err, acp.ErrPeerClosed) || errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

func (m *Manager) fail(err error) {
	m.diagnose(err.Error(), "")
	m.setState(StateError)
}

func startError(err error, operation string) error {
	return fmt.Errorf("agent: %s: %w", operation, err)
}

func (m *Manager) setState(state State) {
	m.mu.Lock()
	changed := m.state != state
	m.state = state
	m.mu.Unlock()
	if changed {
		m.emit(Event{Kind: EventState, State: state})
	}
}

func (m *Manager) emit(event Event) {
	m.mu.Lock()
	if event.State == "" {
		event.State = m.state
	}
	if event.Generation == 0 {
		event.Generation = m.generation
	}
	if event.Turn == 0 {
		event.Turn = m.turn
	}
	m.mu.Unlock()
	if event.At.IsZero() {
		event.At = time.Now()
	}
	critical := event.Kind != EventText && event.Kind != EventThought && event.Kind != EventDiagnostic &&
		event.Kind != EventTool && event.Kind != EventPlan
	if critical {
		m.events <- event // Bounded backpressure; lifecycle events must not disappear.
		return
	}
	if dropped, sent := m.offerEvent(event); !sent {
		m.handleDroppedEvent(dropped)
	}
}

// emitTurn serializes acceptance with cancellation and TurnEnd.
func (m *Manager) emitTurn(p *peer, generation, turn uint64, event Event) bool {
	var droppedEvents []Event
	m.mu.Lock()
	if !m.acceptTurnLocked(p, generation, turn) {
		m.mu.Unlock()
		return false
	}
	event.Generation = generation
	event.Turn = turn
	event.State = m.state
	if event.At.IsZero() {
		event.At = time.Now()
	}
	if dropped, sent := m.offerEvent(event); !sent {
		droppedEvents = append(droppedEvents, dropped)
	}
	m.mu.Unlock()
	for _, dropped := range droppedEvents {
		m.handleDroppedEvent(dropped)
	}
	return true
}

func (m *Manager) acceptTurnLocked(p *peer, generation, turn uint64) bool {
	if m.peer != p || p.stopping.Load() || m.generation != generation || p.generation != generation {
		return false
	}
	if m.state == StateStarting && turn == 0 {
		return true
	}
	return turn != 0 && m.active && !m.cancelRequested && m.turn == turn
}

func (m *Manager) offerEvent(event Event) (Event, bool) {
	select {
	case m.events <- event:
		return Event{}, true
	default:
		return event, false
	}
}

func (m *Manager) handleDroppedEvent(dropped Event) {
	m.recordDiagnostic("event queue full; dropped " + string(dropped.Kind) + " event")
	if dropped.Kind == EventPermission && dropped.RequestID != "" {
		m.cancelPermission(dropped.RequestID)
	}
}

func (m *Manager) queueText(p *peer, generation, turn uint64, kind EventKind, messageID, text string) {
	if text == "" {
		return
	}
	m.batchMu.Lock()
	if m.batch != nil && (m.batch.peer != p || m.batch.generation != generation || m.batch.turn != turn ||
		m.batch.kind != kind || m.batch.messageID != messageID) {
		m.flushTextLocked()
	}
	if m.batch == nil {
		m.batch = &textBatch{peer: p, generation: generation, turn: turn, kind: kind, messageID: messageID}
		m.batchTimer = time.AfterFunc(textBatchDelay, m.flushText)
	}
	m.batch.text += text
	m.batchMu.Unlock()
}

func (m *Manager) flushText() {
	m.batchMu.Lock()
	m.flushTextLocked()
	m.batchMu.Unlock()
}

func (m *Manager) flushTextLocked() {
	if m.batch == nil {
		return
	}
	batch := m.batch
	m.batch = nil
	if m.batchTimer != nil {
		m.batchTimer.Stop()
		m.batchTimer = nil
	}
	m.emitTurn(batch.peer, batch.generation, batch.turn, Event{Kind: batch.kind, Text: batch.text})
}

func (m *Manager) completePermission(id string, pending *pendingPermission, result permissionResult) bool {
	m.mu.Lock()
	if m.pending[id] != pending {
		m.mu.Unlock()
		return false
	}
	delete(m.pending, id)
	m.mu.Unlock()
	m.emit(Event{
		Kind: EventPermissionEnd, RequestID: id, ToolCallID: pending.toolCallID,
		Generation: pending.generation, Turn: pending.turn,
	})
	pending.result <- result
	return true
}

func (m *Manager) cancelPermission(id string) {
	m.mu.Lock()
	request := m.pending[id]
	m.mu.Unlock()
	if request != nil {
		m.completePermission(id, request, permissionResult{cancel: true})
	}
}

func (m *Manager) cancelPermissions(p *peer) {
	m.mu.Lock()
	var pending []struct {
		id      string
		request *pendingPermission
	}
	for id, request := range m.pending {
		if request.peer == p {
			pending = append(pending, struct {
				id      string
				request *pendingPermission
			}{id: id, request: request})
		}
	}
	m.mu.Unlock()
	for _, item := range pending {
		m.completePermission(item.id, item.request, permissionResult{cancel: true})
	}
}

func errorString(err error) string {
	if err == nil {
		return "unknown error"
	}
	return err.Error()
}

var (
	secretAssignment = regexp.MustCompile(`(?i)(token|secret|password|api[_-]?key|authorization)\s*[:=]\s*\S+`)
	privateKey       = regexp.MustCompile(`-----BEGIN [^-\r\n]*PRIVATE KEY-----`)
	credential       = regexp.MustCompile(`sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}`)
)

func cleanDiagnostic(s string) string {
	s = secretAssignment.ReplaceAllString(s, `$1: <redacted>`)
	s = privateKey.ReplaceAllString(s, `<redacted private key>`)
	s = credential.ReplaceAllString(s, `<redacted>`)
	if len(s) > rawDiagnosticSize {
		s = s[:rawDiagnosticSize] + "…"
	}
	return strings.ToValidUTF8(s, "�")
}

type tailWriter struct {
	mu    sync.Mutex
	buf   []byte
	limit int
}

func (w *tailWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	w.buf = append(w.buf, p...)
	if len(w.buf) > w.limit {
		copy(w.buf, w.buf[len(w.buf)-w.limit:])
		w.buf = w.buf[:w.limit]
	}
	w.mu.Unlock()
	return len(p), nil
}

func (w *tailWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return string(append([]byte(nil), w.buf...))
}
