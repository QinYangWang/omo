package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/QinYangWang/omo/internal/agent"
)

// agentRuntime is the app-facing portion of agent.Manager. The interface keeps
// app state tests independent of processes and the ACP SDK.
type agentRuntime interface {
	Start(context.Context, agent.Definition, string) error
	StartSession(context.Context, agent.Definition, string, string) error
	Prompt(context.Context, string) error
	Cancel(context.Context) error
	Restart(context.Context, agent.Definition, string) error
	Resolve(string, string) bool
	Close(context.Context) error
	Snapshot() (agent.State, string, bool)
	Diagnostics() []string
}

// ChatItem is one bounded transcript entry. Tool entries are replaced in place
// as ACP reports progress; adjacent text deltas are coalesced by the manager.
type ChatItem struct {
	Kind       agent.EventKind
	Text       string
	ToolCallID string
	User       bool
}

// AgentPermission is the currently pending approval. A nil value means no
// request is waiting. Closing its dialog cancels the turn rather than allowing.
type AgentPermission struct {
	RequestID string
	Title     string
	Kind      string
	Paths     []string
	Command   []string
	Input     string
	Options   []agent.PermissionOption
}

// AgentConfigDraft is editable form state. Args and Env contain one entry per
// line so the UI never has to parse a shell command line.
// AgentTrustDetails is the exact launch boundary shown before first trust.
// Env contains names only, never secret values.
type AgentTrustDetails struct {
	Executable string
	Args       []string
	Cwd        string
	Env        []string
}

type AgentConfigDraft struct {
	ID         string
	Name       string
	Executable string
	Args       string
	Env        string
	Open       bool
}

const (
	maxChatItems     = 128
	maxChatItemBytes = 64 << 10 // About 8 MiB of transcript text in the worst case.
	maxDiagnostics   = 100
)

func loadAgentCatalog() (*agent.Catalog, error) {
	dir := os.Getenv("OMO_CONFIG_DIR")
	var err error
	if dir == "" {
		dir, err = os.UserConfigDir()
	}
	if err != nil {
		dir = os.TempDir()
	}
	catalog := agent.NewCatalog(filepath.Join(dir, "omo", "agents.json"))
	if err := catalog.Load(); err != nil {
		return nil, err
	}
	return catalog, nil
}

// AgentDefinitions returns the configured agents in catalog order.
func (a *App) AgentDefinitions() []agent.Definition {
	if a.agentCatalog == nil {
		return nil
	}
	return a.agentCatalog.List()
}

// AgentState is the current connection/turn state.
func (a *App) AgentState() agent.State { return a.agentState }

// ActiveAgentID is the selected agent, whether running or not.
func (a *App) ActiveAgentID() string { return a.activeAgentID }

// ChatItems returns the bounded in-memory transcript.
func (a *App) ChatItems() []ChatItem { return a.chatItems }

// AgentInput is the draft bound to the prompt input.
func (a *App) AgentInput() *string { return &a.agentInput }

// Permission returns the pending permission request, if any.
func (a *App) Permission() *AgentPermission { return a.permission }

// TrustAgentID returns the agent awaiting first-run confirmation.
func (a *App) TrustAgentID() string { return a.trustAgentID }

// TrustDetails returns the launch details for the pending trust decision.
func (a *App) TrustDetails() AgentTrustDetails { return a.trustDetails }

// AgentConfigForm returns the draft for immediate-mode input bindings.
func (a *App) AgentConfigForm() *AgentConfigDraft { return &a.agentConfig }

// AgentPickerOpen reports whether the catalog dialog is visible.
func (a *App) AgentPickerOpen() bool { return a.agentPicker }

// AgentDiagnostics returns recent protocol/process diagnostics.
func (a *App) AgentDiagnostics() []string { return a.agentDiagnostics }

// CanRestore reports whether the current agent advertised session/load.
func (a *App) CanRestore() bool { return a.agentCanLoad }

func (a *App) agentDefinition(id string) (agent.Definition, bool) {
	if a.agentCatalog == nil {
		return agent.Definition{}, false
	}
	return a.agentCatalog.Get(id)
}

func (a *App) startAgent(id string) {
	if a.AgentState() == agent.StateStarting || a.AgentState() == agent.StatePrompting || a.AgentState() == agent.StateCancelling {
		a.setNotice(Notice{Key: "agentBusy"})
		return
	}
	def, ok := a.agentDefinition(id)
	if !ok {
		a.setNotice(Notice{Key: "agentNoDefinition"})
		return
	}
	a.activeAgentID = id
	if a.WorkspacePath() == "" {
		a.setNotice(Notice{Key: "noticeNeedWorkspace"})
		return
	}
	if def.Trusted {
		if _, err := agent.VerifyTrusted(def); err != nil {
			def.Trusted = false
			if saveErr := a.agentCatalog.Upsert(def); saveErr != nil {
				a.setNotice(Notice{Key: "agentConfigFailed", Args: map[string]any{"err": saveErr.Error()}})
				return
			}
		}
	}
	if !def.Trusted {
		a.trustAgentID = id
		a.trustDetails = AgentTrustDetails{Executable: def.Executable, Args: def.Args, Cwd: a.WorkspacePath()}
		if resolved, err := exec.LookPath(def.Executable); err == nil {
			a.trustDetails.Executable = resolved
		}
		for _, entry := range def.Env {
			name, _, _ := strings.Cut(entry, "=")
			a.trustDetails.Env = append(a.trustDetails.Env, name)
		}
		return
	}
	a.runAgent(def, "", false)
}

// runAgent owns one asynchronous start/prompt operation. The UI thread only
// prepares state; all process and protocol calls happen in this goroutine.
func (a *App) runAgent(def agent.Definition, prompt string, restart bool) {
	if a.agents == nil {
		return
	}
	cwd := a.WorkspacePath()
	ctx := a.agentCtx
	state := a.AgentState()
	a.agentOperation++
	operation := a.agentOperation
	if restart {
		a.agentNeedsRestart = false
	}
	if prompt != "" && state == agent.StateReady && !restart {
		a.setAgentState(agent.StatePrompting) // Reject a second click synchronously.
	} else {
		a.setAgentState(agent.StateStarting)
	}
	a.Layout.ActiveTab = -1 // Show the central session pane.
	// A session this workspace used before is asked for back; an agent without
	// session/load answers with a new one and the manager says so.
	restoreID := ""
	if !restart {
		restoreID = a.storedSession(def.ID)
	}
	go func() {
		var err error
		switch {
		case restart:
			err = a.agents.Restart(ctx, def, cwd)
		case state != agent.StateReady || prompt == "":
			err = a.agents.StartSession(ctx, def, cwd, restoreID)
		}
		if err == nil && prompt != "" {
			err = a.agents.Prompt(ctx, prompt)
		}
		if err != nil && !errors.Is(err, context.Canceled) {
			a.post(func() {
				if operation != a.agentOperation {
					return
				}
				a.appendDiagnostic(err.Error())
				state, _, _ := a.agents.Snapshot()
				a.setAgentState(state) // RPC failure does not imply connection failure.
			})
			return
		}
		a.post(func() {
			if operation != a.agentOperation {
				return
			}
			a.persistSession()
		})
	}()
}

func (a *App) sendPrompt() {
	text := strings.TrimSpace(a.agentInput)
	if text == "" {
		return
	}
	if a.AgentState() == agent.StatePrompting || a.AgentState() == agent.StateStarting || a.AgentState() == agent.StateCancelling {
		a.setNotice(Notice{Key: "agentBusy"})
		return
	}
	def, ok := a.agentDefinition(a.activeAgentID)
	if !ok {
		a.setNotice(Notice{Key: "agentNoDefinition"})
		return
	}
	if !def.Trusted {
		a.trustAgentID = def.ID
		return
	}
	if a.WorkspacePath() == "" {
		a.setNotice(Notice{Key: "noticeNeedWorkspace"})
		return
	}
	a.agentInput = ""
	a.appendChat(ChatItem{Kind: agent.EventText, Text: text, User: true})
	a.runAgent(def, text, a.agentNeedsRestart)
}

func (a *App) cancelTurn() {
	if a.agents == nil {
		return
	}
	if a.AgentState() == agent.StateStarting {
		a.closeAgent()
		return
	}
	a.permission = nil
	a.permissionQueue = nil
	go func() {
		if err := a.agents.Cancel(a.ctx); err != nil && !errors.Is(err, context.Canceled) {
			a.post(func() { a.appendDiagnostic(err.Error()) })
		}
	}()
}

func (a *App) resolvePermission(optionID string) {
	if a.permission == nil || a.agents == nil {
		return
	}
	id := a.permission.RequestID
	if !a.agents.Resolve(id, optionID) {
		a.appendDiagnostic("permission request was no longer pending")
		return
	}
	a.dismissPermission(id)
}

func (a *App) dismissPermission(requestID string) {
	if a.permission != nil && a.permission.RequestID == requestID {
		a.permission = nil
		if len(a.permissionQueue) > 0 {
			next := a.permissionQueue[0]
			a.permissionQueue = a.permissionQueue[1:]
			a.permission = &next
		}
		return
	}
	for i := range a.permissionQueue {
		if a.permissionQueue[i].RequestID == requestID {
			a.permissionQueue = append(a.permissionQueue[:i], a.permissionQueue[i+1:]...)
			return
		}
	}
}

func (a *App) trustAgent(id string) {
	def, ok := a.agentDefinition(id)
	a.trustAgentID = ""
	if !ok {
		return
	}
	approved, err := agent.Approve(def)
	if err != nil {
		a.setNotice(Notice{Key: "agentConfigFailed", Args: map[string]any{"err": err.Error()}})
		return
	}
	if err := a.agentCatalog.Upsert(approved); err != nil {
		a.setNotice(Notice{Key: "agentConfigFailed", Args: map[string]any{"err": err.Error()}})
		return
	}
	a.startAgent(id)
}

func (a *App) saveAgentConfig() {
	d := &a.agentConfig
	if a.agentCatalog == nil {
		a.setNotice(Notice{Key: "agentCatalogFailed", Args: map[string]any{"err": a.agentCatalogErr.Error()}})
		d.Open = false
		return
	}
	name := strings.TrimSpace(d.Name)
	executable := strings.TrimSpace(d.Executable)
	if name == "" || executable == "" {
		a.setNotice(Notice{Key: "agentConfigRequired"})
		return
	}
	id := d.ID
	trusted := false
	newDefinition := id == ""
	if newDefinition {
		id = fmt.Sprintf("agent-%d", time.Now().UnixNano())
	} else if old, ok := a.agentDefinition(id); ok {
		trusted = old.Trusted && old.Executable == executable
	}
	def := agent.Definition{
		ID: id, Name: name, Executable: executable,
		Args: splitLines(d.Args), Env: splitLines(d.Env), Trusted: trusted,
	}
	if err := a.agentCatalog.Upsert(def); err != nil {
		a.setNotice(Notice{Key: "agentConfigFailed", Args: map[string]any{"err": err.Error()}})
		return
	}
	if a.activeAgentID == "" || !newDefinition && a.activeAgentID == id {
		a.activeAgentID = id
	}
	d.Open = false
	a.setNotice(Notice{Key: "agentConfigSaved", Args: map[string]any{"name": name}})
}

func splitLines(s string) []string {
	var out []string
	for line := range strings.Lines(s) {
		if line = strings.TrimSpace(line); line != "" {
			out = append(out, line)
		}
	}
	return out
}

func (a *App) editAgentConfig(id string) {
	a.agentPicker = false
	a.agentConfig = AgentConfigDraft{Open: true}
	if def, ok := a.agentDefinition(id); ok {
		a.agentConfig.ID = def.ID
		a.agentConfig.Name = def.Name
		a.agentConfig.Executable = def.Executable
		a.agentConfig.Args = strings.Join(def.Args, "\n")
		a.agentConfig.Env = strings.Join(def.Env, "\n")
	}
}

func (a *App) deleteAgent(id string) {
	if id == "" || a.agentCatalog == nil {
		return
	}
	if a.activeAgentID == id {
		a.closeAgent()
		a.activeAgentID = ""
		a.chatItems = nil
	}
	if err := a.agentCatalog.Delete(id); err != nil {
		a.setNotice(Notice{Key: "agentConfigFailed", Args: map[string]any{"err": err.Error()}})
	}
}

func (a *App) closeAgent() {
	if a.agents == nil {
		return
	}
	a.agentOperation++
	a.agentCancel()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := a.agents.Close(ctx); err != nil {
		a.appendDiagnostic(err.Error())
	}
	a.setAgentState(agent.StateDisconnected)
	a.agentNeedsRestart = false
	a.permission = nil
	a.permissionQueue = nil
	a.trustAgentID = ""
	a.agentNotice = Notice{Key: "agentDisconnected"}
	a.agentCtx, a.agentCancel = context.WithCancel(a.ctx)
}

func (a *App) setAgentState(state agent.State) {
	if state == "" {
		return
	}
	a.agentState = state
	a.agentNotice = Notice{Key: "agent" + strings.ToUpper(string(state[:1])) + string(state[1:])}
}

func (a *App) onAgentEvent(ev agent.Event) {
	switch ev.Kind {
	case agent.EventState:
		a.setAgentState(ev.State)
		if ev.State == agent.StateError || ev.State == agent.StateDisconnected {
			a.permission = nil
			a.permissionQueue = nil
		}
	case agent.EventText, agent.EventThought:
		a.appendChat(ChatItem{Kind: ev.Kind, Text: ev.Text})
	case agent.EventTool:
		a.upsertToolChat(ev)
		a.NoteAgentPaths(ev.Paths...)
	case agent.EventPlan:
		if ev.Text != "" {
			a.appendChat(ChatItem{Kind: ev.Kind, Text: ev.Text})
		}
	case agent.EventPermission:
		request := AgentPermission{
			RequestID: ev.RequestID, Title: ev.Title, Kind: ev.KindDetail,
			Paths: ev.Paths, Command: ev.Command, Input: ev.Input, Options: ev.Options,
		}
		a.NoteAgentPaths(ev.Paths...)
		if a.permission == nil {
			a.permission = &request
		} else if len(a.permissionQueue) < 32 {
			a.permissionQueue = append(a.permissionQueue, request)
		} else {
			a.appendDiagnostic("permission queue full; cancelling the active turn")
			a.cancelTurn()
		}
	case agent.EventPermissionEnd:
		a.dismissPermission(ev.RequestID)
	case agent.EventSessionReplaced:
		a.chatItems = nil
		a.chatSeal = false
		a.setNotice(Notice{Key: "agentSessionReplaced"})
		a.appendDiagnostic(firstNonempty(ev.Text, ev.Raw))
		a.persistSession()
	case agent.EventDiagnostic:
		a.appendDiagnostic(firstNonempty(ev.Text, ev.Raw))
	case agent.EventTurnEnd:
		a.chatSeal = true
		a.permission = nil
		a.permissionQueue = nil
		if ev.StopReason == "cancelled" {
			a.agentNeedsRestart = true
		}
		if ev.StopReason != "" {
			a.appendDiagnostic("turn ended: " + ev.StopReason)
		}
		a.refreshReview()
		a.recordTurn(ev.StopReason)
		a.refreshGit(true)
	}
	if a.agents != nil {
		_, _, a.agentCanLoad = a.agents.Snapshot()
	}
}

func firstNonempty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func (a *App) appendChat(item ChatItem) {
	if item.Text == "" {
		return
	}
	if len(item.Text) > maxChatItemBytes {
		item.Text = item.Text[:maxChatItemBytes] + "…"
	}
	if n := len(a.chatItems); n > 0 && item.ToolCallID == "" {
		last := &a.chatItems[n-1]
		if last.Kind == item.Kind && !a.chatSeal && !last.User && !item.User && len(last.Text)+len(item.Text) <= maxChatItemBytes {
			last.Text += item.Text
			return
		}
	}
	a.chatItems = append(a.chatItems, item)
	a.chatSeal = false
	if len(a.chatItems) > maxChatItems {
		a.chatItems = append(a.chatItems[:0], a.chatItems[len(a.chatItems)-maxChatItems:]...)
	}
}

func (a *App) upsertToolChat(ev agent.Event) {
	text := ev.Title
	if ev.Text != "" {
		if text != "" {
			text += " · "
		}
		text += ev.Text
	}
	for i := range a.chatItems {
		if a.chatItems[i].Kind == agent.EventTool && a.chatItems[i].ToolCallID == ev.ToolCallID {
			if ev.Title == "" {
				base, _, _ := strings.Cut(a.chatItems[i].Text, " · ")
				text = base
				if ev.Text != "" {
					text += " · " + ev.Text
				}
			}
			a.chatItems[i].Text = text
			return
		}
	}
	a.appendChat(ChatItem{Kind: agent.EventTool, ToolCallID: ev.ToolCallID, Text: text})
}

func (a *App) appendDiagnostic(text string) {
	if text == "" {
		return
	}
	const max = 4096
	if len(text) > max {
		text = text[:max] + "…"
	}
	a.agentDiagnostics = append(a.agentDiagnostics, text)
	if len(a.agentDiagnostics) > maxDiagnostics {
		a.agentDiagnostics = append(a.agentDiagnostics[:0], a.agentDiagnostics[len(a.agentDiagnostics)-maxDiagnostics:]...)
	}
}
