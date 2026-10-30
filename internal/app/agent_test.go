package app

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/QinYangWang/omo/internal/agent"
)

type fakeAgentRuntime struct {
	mu        sync.Mutex
	state     agent.State
	starts    int
	prompts   []string
	cancels   int
	restarts  int
	resolved  [][2]string
	closed    int
	sessionID string
	canLoad   bool
}

func (f *fakeAgentRuntime) Start(context.Context, agent.Definition, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts++
	f.state = agent.StateReady
	f.sessionID = "session-1"
	return nil
}
func (f *fakeAgentRuntime) Prompt(_ context.Context, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prompts = append(f.prompts, text)
	f.state = agent.StateReady
	return nil
}
func (f *fakeAgentRuntime) Cancel(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancels++
	f.state = agent.StateReady
	return nil
}
func (f *fakeAgentRuntime) Restart(context.Context, agent.Definition, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.restarts++
	f.state = agent.StateReady
	return nil
}
func (f *fakeAgentRuntime) Resolve(id, option string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.resolved = append(f.resolved, [2]string{id, option})
	return true
}
func (f *fakeAgentRuntime) Close(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed++
	f.state = agent.StateDisconnected
	return nil
}
func (f *fakeAgentRuntime) Snapshot() (agent.State, string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state, f.sessionID, f.canLoad
}
func (f *fakeAgentRuntime) Diagnostics() []string { return nil }

func newAgentTestApp(t *testing.T) (*App, *fakeAgentRuntime) {
	t.Helper()
	t.Setenv("OMO_CONFIG_DIR", t.TempDir())
	a, _ := newTestApp(t)
	fake := &fakeAgentRuntime{state: agent.StateDisconnected}
	a.agents = fake
	return a, fake
}

func saveTestAgent(a *App) {
	a.agentConfig = AgentConfigDraft{Open: true, Name: "Test", Executable: os.Args[0], Args: "--acp\n--verbose", Env: "LANG=C"}
	a.Dispatch(SaveAgentConfig{})
}

func TestAgentRequiresTrustBeforeStarting(t *testing.T) {
	a, fake := newAgentTestApp(t)
	saveTestAgent(a)
	id := a.ActiveAgentID()
	if id == "" || a.agentConfig.Open {
		t.Fatal("valid agent configuration was not saved")
	}
	a.Dispatch(StartAgent{ID: id})
	if a.TrustAgentID() != id || fake.starts != 0 {
		t.Fatalf("trust=%q starts=%d", a.TrustAgentID(), fake.starts)
	}
	if details := a.TrustDetails(); details.Executable == "" || details.Cwd == "" || len(details.Args) != 2 || len(details.Env) != 1 || details.Env[0] != "LANG" {
		t.Fatalf("trust details = %+v", details)
	}
	a.Dispatch(TrustAgent{ID: id})
	def, ok := a.agentDefinition(id)
	if !ok || !def.Trusted {
		t.Fatal("trust was not persisted")
	}
	// TrustAgent starts asynchronously, so the fake is exercised directly in
	// the prompt test below rather than sleeping for a scheduling accident.
}

type blockingStartRuntime struct {
	fakeAgentRuntime
	started chan struct{}
}

func (f *blockingStartRuntime) Start(ctx context.Context, _ agent.Definition, _ string) error {
	close(f.started)
	<-ctx.Done()
	return ctx.Err()
}

func TestCloseCancelsPendingStart(t *testing.T) {
	a, _ := newAgentTestApp(t)
	fake := &blockingStartRuntime{started: make(chan struct{})}
	fake.state = agent.StateDisconnected
	a.agents = fake
	saveTestAgent(a)
	a.Dispatch(TrustAgent{ID: a.ActiveAgentID()})
	select {
	case <-fake.started:
	case <-time.After(time.Second):
		t.Fatal("start did not begin")
	}
	done := make(chan struct{})
	go func() {
		a.closeAgent()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("close waited for an uncancelled start")
	}
}

func TestInvalidCatalogIsNotOverwritten(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OMO_CONFIG_DIR", dir)
	path := filepath.Join(dir, "omo", "agents.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	original := []byte("not valid json")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	a := New()
	t.Cleanup(a.Shutdown)
	saveTestAgent(a)
	if a.Notice().Key != "agentCatalogFailed" {
		t.Fatalf("notice = %q", a.Notice().Key)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(original) {
		t.Fatalf("catalog changed: %q, %v", got, err)
	}
}

func TestAgentConfigRoundTripAndSelect(t *testing.T) {
	a, _ := newAgentTestApp(t)
	saveTestAgent(a)
	def, ok := a.agentDefinition(a.ActiveAgentID())
	if !ok || len(def.Args) != 2 || def.Args[0] != "--acp" {
		t.Fatalf("definition = %+v", def)
	}
	a.Dispatch(EditAgentConfig{ID: def.ID})
	if a.agentConfig.Args != "--acp\n--verbose" {
		t.Fatalf("args draft = %q", a.agentConfig.Args)
	}
	a.agentConfig.Name = "Renamed"
	a.Dispatch(SaveAgentConfig{})
	if got, _ := a.agentDefinition(def.ID); got.Name != "Renamed" {
		t.Fatalf("name = %q", got.Name)
	}
	a.Dispatch(DeleteAgent{ID: def.ID})
	if len(a.AgentDefinitions()) != 0 {
		t.Fatal("definition survived deletion")
	}
}

func TestSendPromptIsBoundedAndUsesCurrentDefinition(t *testing.T) {
	a, _ := newAgentTestApp(t)
	saveTestAgent(a)
	a.Dispatch(TrustAgent{ID: a.ActiveAgentID()})
	a.agentState = agent.StateReady
	*a.AgentInput() = "  hello agent  "
	a.sendPrompt()
	if *a.AgentInput() != "" || len(a.ChatItems()) != 1 || !a.ChatItems()[0].User {
		t.Fatalf("input=%q chat=%+v", *a.AgentInput(), a.ChatItems())
	}
	if a.ChatItems()[0].Text != "hello agent" {
		t.Fatalf("prompt = %q", a.ChatItems()[0].Text)
	}
	*a.AgentInput() = "duplicate"
	a.sendPrompt()
	if len(a.ChatItems()) != 1 || a.AgentState() != agent.StatePrompting {
		t.Fatalf("second prompt passed while busy: %+v %q", a.ChatItems(), a.AgentState())
	}
}

func TestPromptAfterCancellationRestartsConnection(t *testing.T) {
	a, fake := newAgentTestApp(t)
	saveTestAgent(a)
	def, _ := a.agentDefinition(a.ActiveAgentID())
	approved, err := agent.Approve(def)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.agentCatalog.Upsert(approved); err != nil {
		t.Fatal(err)
	}
	a.agentState = agent.StateReady
	a.onAgentEvent(agent.Event{Kind: agent.EventTurnEnd, StopReason: "cancelled"})
	*a.AgentInput() = "next turn"
	a.sendPrompt()
	deadline := time.Now().Add(time.Second)
	for {
		fake.mu.Lock()
		restarts, prompts := fake.restarts, len(fake.prompts)
		fake.mu.Unlock()
		if restarts == 1 && prompts == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("restart=%d prompts=%d", restarts, prompts)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestSavingAnotherAgentDoesNotRenameRunningSession(t *testing.T) {
	a, _ := newAgentTestApp(t)
	saveTestAgent(a)
	first := a.ActiveAgentID()
	a.agentState = agent.StateReady
	a.agentConfig = AgentConfigDraft{Open: true, Name: "Second", Executable: os.Args[0]}
	a.Dispatch(SaveAgentConfig{})
	if a.ActiveAgentID() != first {
		t.Fatalf("active agent changed from %q to %q", first, a.ActiveAgentID())
	}
}

func TestAgentEventsUpdateTranscriptAndPermission(t *testing.T) {
	a, _ := newAgentTestApp(t)
	a.onAgentEvent(agent.Event{Kind: agent.EventText, Text: "hel"})
	a.onAgentEvent(agent.Event{Kind: agent.EventText, Text: "lo"})
	a.onAgentEvent(agent.Event{Kind: agent.EventTool, ToolCallID: "tool-1", Title: "Read file"})
	a.onAgentEvent(agent.Event{Kind: agent.EventTool, ToolCallID: "tool-1", Title: "Read file · done"})
	if len(a.ChatItems()) != 2 || a.ChatItems()[0].Text != "hello" || a.ChatItems()[1].Text != "Read file · done" {
		t.Fatalf("chat = %+v", a.ChatItems())
	}
	a.onAgentEvent(agent.Event{
		Kind: agent.EventPermission, RequestID: "request-1", Title: "Write file",
		KindDetail: "edit", Paths: []string{"main.go"}, Command: []string{"tool", "--write"},
		Options: []agent.PermissionOption{{ID: "allow", Name: "Allow"}},
	})
	if a.Permission() == nil || a.Permission().Kind != "edit" || len(a.Permission().Paths) != 1 || len(a.Permission().Command) != 2 {
		t.Fatalf("permission details were not exposed: %+v", a.Permission())
	}
	a.Dispatch(ResolvePermission{OptionID: "allow"})
	if a.Permission() != nil {
		t.Fatal("permission did not close")
	}
}

func TestTurnsDoNotShareTranscriptItems(t *testing.T) {
	a, _ := newAgentTestApp(t)
	a.onAgentEvent(agent.Event{Kind: agent.EventText, Text: "first"})
	a.onAgentEvent(agent.Event{Kind: agent.EventTurnEnd, StopReason: "end_turn"})
	a.onAgentEvent(agent.Event{Kind: agent.EventText, Text: "second"})
	if len(a.ChatItems()) != 2 || a.ChatItems()[0].Text != "first" || a.ChatItems()[1].Text != "second" {
		t.Fatalf("chat = %+v", a.ChatItems())
	}
}

func TestPermissionEndAndSessionReplacement(t *testing.T) {
	a, _ := newAgentTestApp(t)
	a.onAgentEvent(agent.Event{Kind: agent.EventPermission, RequestID: "old"})
	a.onAgentEvent(agent.Event{Kind: agent.EventPermissionEnd, RequestID: "old"})
	if a.Permission() != nil {
		t.Fatal("expired permission stayed visible")
	}
	a.appendChat(ChatItem{Kind: agent.EventText, Text: "old history"})
	a.onAgentEvent(agent.Event{Kind: agent.EventSessionReplaced, Text: "load unsupported"})
	if len(a.ChatItems()) != 0 || a.Notice().Key != "agentSessionReplaced" {
		t.Fatalf("old session context survived: %+v %q", a.ChatItems(), a.Notice().Key)
	}
}

func TestPermissionRequestsQueueAndUserMessagesDoNotMerge(t *testing.T) {
	a, _ := newAgentTestApp(t)
	a.appendChat(ChatItem{Kind: agent.EventText, Text: "agent"})
	a.appendChat(ChatItem{Kind: agent.EventText, Text: "user", User: true})
	if len(a.ChatItems()) != 2 {
		t.Fatal("user text merged into agent text")
	}
	for _, id := range []string{"one", "two"} {
		a.onAgentEvent(agent.Event{Kind: agent.EventPermission, RequestID: id, Options: []agent.PermissionOption{{ID: "reject"}}})
	}
	if a.Permission() == nil || a.Permission().RequestID != "one" {
		t.Fatal("first permission was overwritten")
	}
	a.Dispatch(ResolvePermission{OptionID: "reject"})
	if a.Permission() == nil || a.Permission().RequestID != "two" {
		t.Fatal("second permission was not presented next")
	}
}

func TestTranscriptAndDiagnosticsAreBounded(t *testing.T) {
	a, _ := newAgentTestApp(t)
	for i := 0; i < maxChatItems+20; i++ {
		a.appendChat(ChatItem{Kind: agent.EventTool, ToolCallID: string(rune(i + 1)), Text: "tool"})
	}
	if len(a.ChatItems()) != maxChatItems {
		t.Fatalf("chat items = %d", len(a.ChatItems()))
	}
	for i := 0; i < maxDiagnostics+20; i++ {
		a.appendDiagnostic("diagnostic")
	}
	if len(a.AgentDiagnostics()) != maxDiagnostics {
		t.Fatalf("diagnostics = %d", len(a.AgentDiagnostics()))
	}
}
