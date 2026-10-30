package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
)

func TestManagerStreamingAndUnknownUpdate(t *testing.T) {
	m, events := startTestManager(t, "stream")
	if err := m.Prompt(context.Background(), "hello"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	events.waitFor(t, func(e Event) bool { return e.Kind == EventTurnEnd && e.StopReason == "end_turn" })
	events.waitFor(t, func(e Event) bool { return e.Kind == EventText && e.Text == "hello" })
	events.waitFor(t, func(e Event) bool { return e.Kind == EventThought && e.Text == "thinking" })
	tool := events.waitFor(t, func(e Event) bool { return e.Kind == EventTool && e.ToolCallID == "tool-1" })
	if tool.Generation == 0 || tool.Turn == 0 || tool.KindDetail != "execute" ||
		len(tool.Paths) != 2 || tool.Paths[0] != "inside.txt" || tool.Paths[1] != "<external>" ||
		strings.Join(tool.Command, "|") != "run|arg with spaces" {
		t.Fatalf("tool detail = %#v", tool)
	}
	events.waitFor(t, func(e Event) bool { return e.Kind == EventPlan && strings.Contains(e.Text, "inspect") })
	events.waitFor(t, func(e Event) bool {
		return e.Kind == EventDiagnostic && strings.Contains(e.Text, "future_update")
	})
	var text []Event
	for _, event := range events.all() {
		if event.Kind == EventText {
			text = append(text, event)
		}
	}
	if len(text) != 1 || text[0].Text != "hello" {
		t.Fatalf("coalesced text events = %#v", text)
	}
	state, sessionID, _ := m.Snapshot()
	if state != StateReady || sessionID == "" {
		t.Fatalf("Snapshot = %q, %q", state, sessionID)
	}
}

func TestManagerPermissionDenial(t *testing.T) {
	m, events := startTestManager(t, "permission")
	promptDone := promptAsync(m)
	request := events.waitFor(t, func(e Event) bool { return e.Kind == EventPermission })
	if m.Resolve(request.RequestID, "not-advertised") {
		t.Fatal("Resolve accepted an unadvertised option")
	}
	if !m.Resolve(request.RequestID, "reject") {
		t.Fatal("Resolve rejected a valid option")
	}
	if m.Resolve(request.RequestID, "reject") {
		t.Fatal("Resolve resolved a request twice")
	}
	if err := <-promptDone; err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	events.waitFor(t, func(e Event) bool { return e.Kind == EventTurnEnd && e.StopReason == "refusal" })
	assertPermissionEnd(t, events, request.RequestID)
}

func TestManagerCancelPermission(t *testing.T) {
	m, events := startTestManager(t, "permission")
	promptDone := promptAsync(m)
	events.waitFor(t, func(e Event) bool { return e.Kind == EventPermission })
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := m.Cancel(ctx); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if err := <-promptDone; err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	events.waitFor(t, func(e Event) bool { return e.Kind == EventTurnEnd && e.StopReason == "cancelled" })
	request := events.waitFor(t, func(e Event) bool { return e.Kind == EventPermission })
	assertPermissionEnd(t, events, request.RequestID)
	state, _, _ := m.Snapshot()
	if state != StateReady {
		t.Fatalf("state = %q", state)
	}
}

func TestManagerPermissionTimeoutDenies(t *testing.T) {
	m, events := startTestManager(t, "permission")
	m.permissionTimeout = 30 * time.Millisecond
	if err := m.Prompt(context.Background(), "secret operation"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	events.waitFor(t, func(e Event) bool { return e.Kind == EventTurnEnd && e.StopReason == "refusal" })
	events.waitFor(t, func(e Event) bool {
		return e.Kind == EventDiagnostic && strings.Contains(e.Text, "timed out; denied")
	})
	request := events.waitFor(t, func(e Event) bool { return e.Kind == EventPermission })
	assertPermissionEnd(t, events, request.RequestID)
}

func TestManagerCancelAndLateUpdate(t *testing.T) {
	m, events := startTestManager(t, "slow")
	promptDone := promptAsync(m)
	waitUntil(t, func() bool { state, _, _ := m.Snapshot(); return state == StatePrompting })
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := m.Cancel(ctx); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if err := <-promptDone; err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	events.waitFor(t, func(e Event) bool {
		return e.Kind == EventDiagnostic && strings.Contains(e.Text, "late or unrelated")
	})
	for _, event := range events.all() {
		if event.Kind == EventText && strings.Contains(event.Text, "late") {
			t.Fatalf("late update reached transcript: %#v", event)
		}
	}
}

func TestManagerIgnoredCancelTimesOutUnknown(t *testing.T) {
	m, events := startTestManager(t, "ignore-cancel")
	promptDone := promptAsync(m)
	waitPromptDispatched(t, m)
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := m.Cancel(ctx); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if err := <-promptDone; !errors.Is(err, ErrTurnUnknown) {
		t.Fatalf("Prompt error = %v, want ErrTurnUnknown", err)
	}
	if elapsed := time.Since(started); elapsed > 4*time.Second {
		t.Fatalf("ignored cancellation took %v", elapsed)
	}
	if state, _, _ := m.Snapshot(); state != StateError {
		t.Fatalf("state = %q", state)
	}
	m.mu.Lock()
	peer := m.peer
	m.mu.Unlock()
	if peer != nil {
		t.Fatal("unresponsive peer was not torn down")
	}
	events.waitFor(t, func(e Event) bool { return e.Kind == EventTurnEnd && e.StopReason == "unknown" })
}

func TestManagerCallerCancellationUsesSameWatchdog(t *testing.T) {
	m, _ := startTestManager(t, "ignore-cancel")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- m.Prompt(ctx, "test") }()
	waitPromptDispatched(t, m)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, ErrTurnUnknown) {
			t.Fatalf("Prompt error = %v, want ErrTurnUnknown", err)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("caller cancellation remained blocked")
	}
	if state, _, _ := m.Snapshot(); state != StateError {
		t.Fatalf("state = %q", state)
	}
}

func TestManagerCrashMarksTurnUnknown(t *testing.T) {
	m, events := startTestManager(t, "crash")
	err := m.Prompt(context.Background(), "crash")
	if !errors.Is(err, ErrTurnUnknown) {
		t.Fatalf("Prompt error = %v, want ErrTurnUnknown", err)
	}
	events.waitFor(t, func(e Event) bool { return e.Kind == EventTurnEnd && e.StopReason == "unknown" })
	waitUntil(t, func() bool { state, _, _ := m.Snapshot(); return state == StateError })
	events.waitFor(t, func(e Event) bool {
		return e.Kind == EventDiagnostic && strings.Contains(e.Text, "connection lost")
	})
}

func TestManagerCloseCancelsBlockedStart(t *testing.T) {
	m := NewManager()
	events := collectEvents(m)
	t.Cleanup(events.close)
	startDone := make(chan error, 1)
	go func() { startDone <- m.Start(context.Background(), helperDefinition("hang"), t.TempDir()) }()
	waitUntil(t, func() bool { state, _, _ := m.Snapshot(); return state == StateStarting })
	time.Sleep(50 * time.Millisecond) // Let the helper reach initialize.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := m.Close(ctx); err != nil && !errors.Is(err, context.Canceled) {
		t.Fatalf("Close: %v", err)
	}
	select {
	case <-startDone:
	case <-ctx.Done():
		t.Fatal("Start remained blocked after Close")
	}
	if state, _, _ := m.Snapshot(); state != StateDisconnected {
		t.Fatalf("state = %q", state)
	}
}

func TestManagerRestartWithoutLoadCapability(t *testing.T) {
	restartCWD := t.TempDir()
	m, events := startTestManager(t, "basic")
	_, oldSession, canLoad := m.Snapshot()
	if canLoad || oldSession == "" {
		t.Fatalf("unexpected initial snapshot: %q, %v", oldSession, canLoad)
	}
	def := helperDefinition("basic")
	if err := m.Restart(context.Background(), def, restartCWD); err != nil {
		t.Fatalf("Restart: %v", err)
	}
	state, newSession, canLoad := m.Snapshot()
	if state != StateReady || canLoad || newSession == oldSession {
		t.Fatalf("Snapshot after restart = %q, %q, %v (old %q)", state, newSession, canLoad, oldSession)
	}
	replaced := events.waitFor(t, func(e Event) bool { return e.Kind == EventSessionReplaced })
	if !strings.Contains(replaced.Text, oldSession) || !strings.Contains(replaced.Text, "new session") {
		t.Fatalf("replacement diagnostic = %q", replaced.Text)
	}
}

func TestManagerRestartLoadsSessionWhenAdvertised(t *testing.T) {
	restartCWD := t.TempDir()
	m, _ := startTestManager(t, "load")
	_, oldSession, canLoad := m.Snapshot()
	if !canLoad {
		t.Fatal("helper did not advertise loadSession")
	}
	if err := m.Restart(context.Background(), helperDefinition("load"), restartCWD); err != nil {
		t.Fatalf("Restart: %v", err)
	}
	state, newSession, canLoad := m.Snapshot()
	if state != StateReady || !canLoad || newSession != oldSession {
		t.Fatalf("Snapshot after restart = %q, %q, %v (old %q)", state, newSession, canLoad, oldSession)
	}
}

func TestManagerStartSessionRestoresTheStoredSession(t *testing.T) {
	cwd := t.TempDir()
	m, events := newTestManager(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.StartSession(ctx, helperDefinition("load"), cwd, "session-from-last-run"); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	state, sessionID, canLoad := m.Snapshot()
	if state != StateReady || !canLoad || sessionID != "session-from-last-run" {
		t.Fatalf("Snapshot = %q, %q, %v", state, sessionID, canLoad)
	}
	for _, event := range events.all() {
		if event.Kind == EventSessionReplaced {
			t.Fatalf("a loaded session was reported as replaced: %#v", event)
		}
	}
}

func TestManagerStartSessionSaysWhenItCannotRestore(t *testing.T) {
	cwd := t.TempDir()
	m, events := newTestManager(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.StartSession(ctx, helperDefinition("basic"), cwd, "session-from-last-run"); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	state, sessionID, _ := m.Snapshot()
	if state != StateReady || sessionID == "" || sessionID == "session-from-last-run" {
		t.Fatalf("Snapshot = %q, %q: a new session was expected", state, sessionID)
	}
	replaced := events.waitFor(t, func(e Event) bool { return e.Kind == EventSessionReplaced })
	if !strings.Contains(replaced.Text, "loadSession") {
		t.Fatalf("replacement reason = %q", replaced.Text)
	}
}

// newTestManager returns a manager with an event collector and cleanup, but no
// started agent: the caller decides how it starts.
func newTestManager(t *testing.T) (*Manager, *eventCollector) {
	t.Helper()
	m := NewManager()
	events := collectEvents(m)
	t.Cleanup(events.close)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = m.Close(ctx)
	})
	return m, events
}

func TestManagerRequiresTrustAndSingleTurn(t *testing.T) {
	def := helperDefinition("basic")
	def.Trusted = false
	m := NewManager()
	if err := m.Start(context.Background(), def, t.TempDir()); !errors.Is(err, ErrUntrusted) {
		t.Fatalf("Start error = %v", err)
	}
	m, events := startTestManager(t, "slow")
	promptDone := promptAsync(m)
	waitUntil(t, func() bool { state, _, _ := m.Snapshot(); return state == StatePrompting })
	if err := m.Prompt(context.Background(), "second"); !errors.Is(err, ErrBusy) {
		t.Fatalf("second Prompt error = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := m.Cancel(ctx); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if err := <-promptDone; err != nil {
		t.Fatalf("first Prompt: %v", err)
	}
	events.waitFor(t, func(e Event) bool { return e.Kind == EventTurnEnd })
}

func TestVerifyTrustedDetectsLaunchChanges(t *testing.T) {
	data, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(t.TempDir(), "approved-helper"+filepath.Ext(os.Args[0]))
	if err := os.WriteFile(executable, data, 0o755); err != nil {
		t.Fatal(err)
	}
	def, err := Approve(Definition{
		ID: "helper", Name: "Test helper", Executable: executable,
		Args: []string{"--flag", "exact value"}, Env: []string{"LANG=C"},
	})
	if err != nil {
		t.Fatalf("Approve: %v", err)
	}
	if !def.Trusted || !filepath.IsAbs(def.ApprovedExecutable) || len(def.ApprovedSHA256) != 64 {
		t.Fatalf("approval = %#v", def)
	}
	resolved, err := VerifyTrusted(def)
	if err != nil || resolved != def.ApprovedExecutable {
		t.Fatalf("VerifyTrusted = %q, %v", resolved, err)
	}
	legacy := def
	legacy.ApprovedExecutable = ""
	legacy.ApprovedSHA256 = ""
	legacy.ApprovedArgs = nil
	legacy.ApprovedEnv = nil
	if _, err := VerifyTrusted(legacy); !errors.Is(err, ErrTrustChanged) {
		t.Fatalf("legacy trust error = %v", err)
	}
	changed := def
	changed.Args = append([]string(nil), def.Args...)
	changed.Args[0] = "--different"
	if _, err := VerifyTrusted(changed); !errors.Is(err, ErrTrustChanged) {
		t.Fatalf("argv change error = %v", err)
	}
	changed = def
	changed.Env = []string{"LANG=fr"}
	if _, err := VerifyTrusted(changed); !errors.Is(err, ErrTrustChanged) {
		t.Fatalf("env change error = %v", err)
	}
	if err := os.WriteFile(executable, append(data, 0), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyTrusted(def); !errors.Is(err, ErrTrustChanged) {
		t.Fatalf("replacement binary error = %v", err)
	}
}

func TestManagerRejectsUnsupportedProtocol(t *testing.T) {
	cwd := t.TempDir()
	m := NewManager()
	err := m.Start(context.Background(), helperDefinition("bad-version"), cwd)
	if err == nil || !strings.Contains(err.Error(), "protocol version 2") {
		t.Fatalf("Start error = %v", err)
	}
	state, _, _ := m.Snapshot()
	if state != StateError {
		t.Fatalf("state = %q", state)
	}
}

func TestBoundedEventsDiagnosticsAndRaw(t *testing.T) {
	m := NewManager()
	for range eventBufferSize + 8 {
		m.emit(Event{Kind: EventDiagnostic, Text: "noise"})
	}
	if len(m.events) != eventBufferSize {
		t.Fatalf("event queue length = %d", len(m.events))
	}
	for len(m.events) > 0 {
		<-m.events
	}
	// Lifecycle events apply backpressure rather than disappearing.
	done := make(chan struct{})
	go func() {
		for range eventBufferSize + 8 {
			m.emit(Event{Kind: EventState, State: StateReady})
		}
		close(done)
	}()
	for range eventBufferSize + 8 {
		<-m.events
	}
	<-done
	for i := range diagnosticLimit + 5 {
		m.recordDiagnostic(fmt.Sprint(i))
	}
	diagnostics := m.Diagnostics()
	if len(diagnostics) != diagnosticLimit || diagnostics[0] != "5" || diagnostics[len(diagnostics)-1] != fmt.Sprint(diagnosticLimit+4) {
		t.Fatalf("diagnostic ring boundaries = %d, %q, %q", len(diagnostics), diagnostics[0], diagnostics[len(diagnostics)-1])
	}
	raw := cleanDiagnostic("api_key=supersecret " + strings.Repeat("x", rawDiagnosticSize+100))
	if strings.Contains(raw, "supersecret") || len(raw) > rawDiagnosticSize+len("…") {
		t.Fatalf("diagnostic was not redacted and truncated: %q", raw)
	}
}

func TestCatalogRoundTripAndValidation(t *testing.T) {
	path := t.TempDir() + "/nested/agents.json"
	catalog := NewCatalog(path)
	if err := catalog.Load(); err != nil {
		t.Fatalf("Load missing: %v", err)
	}
	def := helperDefinition("basic")
	def.Env = []string{"LANG=C"}
	if err := catalog.Upsert(def); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	got, ok := catalog.Get(def.ID)
	if !ok || got.Executable != def.Executable {
		t.Fatalf("Get = %#v, %v", got, ok)
	}
	got.Args[0] = "mutated"
	again, _ := catalog.Get(def.ID)
	if again.Args[0] == "mutated" {
		t.Fatal("Get returned aliased argv")
	}
	loaded := NewCatalog(path)
	if err := loaded.Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if defs := loaded.List(); len(defs) != 1 || defs[0].ID != def.ID {
		t.Fatalf("List = %#v", defs)
	}
	invalid := def
	invalid.ID = "bad-env"
	invalid.Env = []string{"MISSING_EQUALS_SIGN"}
	if err := loaded.Upsert(invalid); err == nil {
		t.Fatal("Upsert accepted an invalid environment entry")
	}
	invalid = def
	invalid.ID = "bad-argv"
	invalid.Args = []string{"bad\x00arg"}
	if err := loaded.Upsert(invalid); err == nil {
		t.Fatal("Upsert accepted NUL in argv")
	}
	if err := loaded.Delete(def.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := catalog.Load(); err != nil {
		t.Fatalf("reload after Delete: %v", err)
	}
	if defs := catalog.List(); len(defs) != 0 {
		t.Fatalf("catalog after Delete = %#v", defs)
	}
}

func TestToolInputPreviewSafety(t *testing.T) {
	long := "token=supersecret " + strings.Repeat("x", rawDiagnosticSize+100)
	_, _, command, input := toolCallDetails(acp.ToolCallUpdate{
		RawInput: map[string]any{"note": long, "env": map[string]any{"SECRET": "do-not-show"}},
	}, t.TempDir())
	if len(command) != 0 || strings.Contains(input, "supersecret") || strings.Contains(input, "do-not-show") ||
		len(input) > rawDiagnosticSize+len("…") {
		t.Fatalf("unsafe raw input preview: command=%q input=%q", command, input)
	}
	_, _, command, _ = toolCallDetails(acp.ToolCallUpdate{
		RawInput: map[string]any{"command": []any{"program", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"}},
	}, t.TempDir())
	if len(command) != maxToolCommandItems+1 || command[len(command)-1] != "…" || command[0] != "program" {
		t.Fatalf("bounded argv = %#v", command)
	}
}

func TestMinimalEnvironment(t *testing.T) {
	t.Setenv("AWS_SECRET_ACCESS_KEY", "do-not-pass")
	t.Setenv("LANG", "C")
	env := minimalEnv([]string{"TEMP=/tmp/agent"})
	joined := strings.Join(env, "\n")
	if strings.Contains(joined, "AWS_SECRET_ACCESS_KEY") || strings.Contains(joined, "do-not-pass") {
		t.Fatalf("unsafe environment leaked: %q", joined)
	}
	if !strings.Contains(joined, "LANG=C") || !strings.Contains(joined, "TEMP=/tmp/agent") {
		t.Fatalf("safe environment missing: %q", joined)
	}
	// An explicit per-agent entry is opt-in even when the same inherited name
	// would be filtered. This is needed for runtime modes and explicit auth.
	explicit := strings.Join(minimalEnv([]string{"AWS_SECRET_ACCESS_KEY=explicit"}), "\n")
	if !strings.Contains(explicit, "AWS_SECRET_ACCESS_KEY=explicit") {
		t.Fatalf("explicit environment entry was rejected: %q", explicit)
	}
}

type eventCollector struct {
	mu     sync.Mutex
	events []Event
	notify chan struct{}
	stop   chan struct{}
	done   chan struct{}
}

func collectEvents(m *Manager) *eventCollector {
	c := &eventCollector{notify: make(chan struct{}, 1), stop: make(chan struct{}), done: make(chan struct{})}
	go func() {
		defer close(c.done)
		for {
			select {
			case event := <-m.Events():
				c.mu.Lock()
				c.events = append(c.events, event)
				c.mu.Unlock()
				select {
				case c.notify <- struct{}{}:
				default:
				}
			case <-c.stop:
				return
			}
		}
	}()
	return c
}

func (c *eventCollector) all() []Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Event(nil), c.events...)
}

func (c *eventCollector) waitFor(t *testing.T, match func(Event) bool) Event {
	t.Helper()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		for _, event := range c.all() {
			if match(event) {
				return event
			}
		}
		select {
		case <-c.notify:
		case <-deadline.C:
			t.Fatalf("event not found; events = %#v", c.all())
		}
	}
}

func (c *eventCollector) close() {
	close(c.stop)
	<-c.done
}

func startTestManager(t *testing.T, scenario string) (*Manager, *eventCollector) {
	t.Helper()
	cwd := t.TempDir()
	m := NewManager()
	events := collectEvents(m)
	t.Cleanup(events.close)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = m.Close(ctx)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.Start(ctx, helperDefinition(scenario), cwd); err != nil {
		t.Fatalf("Start: %v", err)
	}
	return m, events
}

func promptAsync(m *Manager) <-chan error {
	done := make(chan error, 1)
	go func() { done <- m.Prompt(context.Background(), "test") }()
	return done
}

func assertPermissionEnd(t *testing.T, events *eventCollector, requestID string) {
	t.Helper()
	events.waitFor(t, func(e Event) bool { return e.Kind == EventPermissionEnd && e.RequestID == requestID })
	count := 0
	for _, event := range events.all() {
		if event.Kind == EventPermissionEnd && event.RequestID == requestID {
			count++
			if event.Generation == 0 || event.Turn == 0 {
				t.Fatalf("permission completion tags = %#v", event)
			}
		}
	}
	if count != 1 {
		t.Fatalf("permission completion count = %d", count)
	}
}

func waitPromptDispatched(t *testing.T, m *Manager) {
	t.Helper()
	waitUntil(t, func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		return m.dispatchDone != nil
	})
	m.mu.Lock()
	done := m.dispatchDone
	m.mu.Unlock()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("prompt dispatch did not finish")
	}
}

func waitUntil(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met before timeout")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func helperDefinition(scenario string) Definition {
	def, err := Approve(Definition{
		ID: "helper", Name: "Test helper", Executable: os.Args[0],
		Args: []string{"-test.run=^TestAgentHelperProcess$", "--", "acp-agent", scenario},
	})
	if err != nil {
		panic(err)
	}
	return def
}

// TestAgentHelperProcess is an argv-gated subprocess, not a normal test.
func TestAgentHelperProcess(t *testing.T) {
	isHelper := false
	for _, arg := range os.Args {
		if arg == "acp-agent" {
			isHelper = true
			break
		}
	}
	if !isHelper {
		return
	}
	runHelper(os.Args[len(os.Args)-1])
}

type helperAgent struct {
	scenario   string
	cwd        string
	conn       *acp.Connection
	cancelled  chan struct{}
	cancelOnce sync.Once
}

func runHelper(scenario string) {
	h := &helperAgent{scenario: scenario, cancelled: make(chan struct{})}
	conn, err := acp.NewConnectionWithOptions(h.handle, os.Stdout, os.Stdin, acp.ConnectionOptions{})
	if err != nil {
		os.Exit(3)
	}
	h.conn = conn
	<-conn.Done()
	os.Exit(0)
}

func (h *helperAgent) handle(ctx context.Context, method string, params json.RawMessage) (any, *acp.RequestError) {
	switch method {
	case acp.AgentMethodInitialize:
		var request acp.InitializeRequest
		if json.Unmarshal(params, &request) != nil || request.ProtocolVersion != 1 ||
			request.ClientCapabilities.Fs.ReadTextFile || request.ClientCapabilities.Fs.WriteTextFile || request.ClientCapabilities.Terminal {
			return nil, acp.NewInvalidParams(map[string]any{"error": "invalid initialize or dishonest capabilities"})
		}
		if h.scenario == "hang" {
			<-ctx.Done()
			return nil, acp.NewInternalError(map[string]any{"error": "initialize cancelled"})
		}
		version := acp.ProtocolVersion(1)
		if h.scenario == "bad-version" {
			version = 2
		}
		return acp.InitializeResponse{
			ProtocolVersion:   version,
			AgentCapabilities: acp.AgentCapabilities{LoadSession: h.scenario == "load"},
		}, nil
	case acp.AgentMethodSessionNew:
		var request acp.NewSessionRequest
		if err := json.Unmarshal(params, &request); err != nil {
			return nil, acp.NewInvalidParams(map[string]any{"error": err.Error()})
		}
		h.cwd = request.Cwd
		return acp.NewSessionResponse{SessionId: acp.SessionId(fmt.Sprintf("session-%d", os.Getpid()))}, nil
	case acp.AgentMethodSessionLoad:
		var request acp.LoadSessionRequest
		if err := json.Unmarshal(params, &request); err != nil {
			return nil, acp.NewInvalidParams(map[string]any{"error": err.Error()})
		}
		h.cwd = request.Cwd
		return acp.LoadSessionResponse{}, nil
	case acp.AgentMethodSessionCancel:
		h.cancelOnce.Do(func() { close(h.cancelled) })
		return nil, nil
	case acp.AgentMethodSessionPrompt:
		return h.prompt(ctx)
	default:
		return nil, acp.NewMethodNotFound(method)
	}
}

func (h *helperAgent) prompt(ctx context.Context) (any, *acp.RequestError) {
	sessionID := fmt.Sprintf("session-%d", os.Getpid())
	switch h.scenario {
	case "stream":
		updates := []map[string]any{
			{"sessionUpdate": "agent_message_chunk", "messageId": "m1", "content": map[string]any{"type": "text", "text": "hel"}},
			{"sessionUpdate": "agent_message_chunk", "messageId": "m1", "content": map[string]any{"type": "text", "text": "lo"}},
			{"sessionUpdate": "agent_thought_chunk", "messageId": "t1", "content": map[string]any{"type": "text", "text": "thinking"}},
			{"sessionUpdate": "tool_call", "toolCallId": "tool-1", "title": "Run", "status": "running", "kind": "execute",
				"locations": []any{map[string]any{"path": filepath.Join(h.cwd, "inside.txt")}, map[string]any{"path": filepath.Join(h.cwd, "..", "outside.txt")}},
				"rawInput":  map[string]any{"command": []string{"run", "arg with spaces"}, "env": map[string]any{"SECRET": "hidden"}}},
			{"sessionUpdate": "plan", "entries": []any{map[string]any{"content": "inspect files", "status": "in_progress"}}},
			{"sessionUpdate": "future_update", "value": 42},
		}
		for _, update := range updates {
			if !h.notify(ctx, sessionID, update) {
				return nil, acp.NewInternalError(map[string]any{"error": "update failed"})
			}
		}
		return acp.PromptResponse{StopReason: acp.StopReasonEndTurn}, nil
	case "permission":
		title := "Write file"
		response, err := acp.SendRequest[acp.RequestPermissionResponse](h.conn, ctx, acp.ClientMethodSessionRequestPermission, acp.RequestPermissionRequest{
			SessionId: acp.SessionId(sessionID),
			ToolCall:  acp.ToolCallUpdate{ToolCallId: "tool-1", Title: &title},
			Options: []acp.PermissionOption{
				{OptionId: "allow", Name: "Allow once", Kind: "allow_once"},
				{OptionId: "reject", Name: "Reject", Kind: "reject_once"},
			},
		})
		if err != nil {
			return nil, acp.NewInternalError(map[string]any{"error": err.Error()})
		}
		if response.Outcome.Cancelled != nil {
			return acp.PromptResponse{StopReason: acp.StopReasonCancelled}, nil
		}
		if response.Outcome.Selected != nil && response.Outcome.Selected.OptionId == "reject" {
			return acp.PromptResponse{StopReason: acp.StopReasonRefusal}, nil
		}
		return acp.PromptResponse{StopReason: acp.StopReasonEndTurn}, nil
	case "slow":
		<-h.cancelled
		time.AfterFunc(80*time.Millisecond, func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			h.notify(ctx, sessionID, map[string]any{
				"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "late"},
			})
		})
		return acp.PromptResponse{StopReason: acp.StopReasonCancelled}, nil
	case "ignore-cancel":
		<-h.conn.Done()
		return nil, acp.NewInternalError(map[string]any{"error": "connection closed after ignored cancellation"})
	case "crash":
		os.Exit(2)
	}
	return acp.PromptResponse{StopReason: acp.StopReasonEndTurn}, nil
}

func (h *helperAgent) notify(ctx context.Context, sessionID string, update map[string]any) bool {
	return h.conn.SendNotification(ctx, acp.ClientMethodSessionUpdate, map[string]any{
		"sessionId": sessionID,
		"update":    update,
	}) == nil
}
