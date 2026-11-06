package app

import (
	"path/filepath"
	"testing"

	"github.com/QinYangWang/omo/internal/agent"
)

func permissionEvent(id, call, kind string) agent.Event {
	return agent.Event{
		Kind: agent.EventPermission, RequestID: id, ToolCallID: call, KindDetail: kind, Title: "write",
		Options: []agent.PermissionOption{
			{ID: "once", Kind: "allow_once"}, {ID: "always", Kind: "allow_always"}, {ID: "no", Kind: "reject_once"},
		},
	}
}

// TestAllowForSessionAnswersLaterRequestsOnce checks the session grant: the
// request is answered with allow_once, and so is the next one of the same
// kind, without asking; allow_always never reaches the agent, and a new
// session forgets the grant.
func TestAllowForSessionAnswersLaterRequestsOnce(t *testing.T) {
	a, fake := newAgentTestApp(t)
	a.onAgentEvent(agent.Event{Kind: agent.EventTool, ToolCallID: "e1", KindDetail: "edit", Text: "pending"})
	a.onAgentEvent(permissionEvent("1", "e1", "edit"))
	a.Dispatch(AllowForSession{})
	a.onAgentEvent(permissionEvent("2", "e2", "edit"))
	if a.Permission() != nil {
		t.Fatal("the second edit should not ask")
	}
	a.onAgentEvent(permissionEvent("3", "x1", "execute"))
	if a.Permission() == nil {
		t.Fatal("another kind must still ask")
	}
	want := [][2]string{{"1", "once"}, {"2", "once"}}
	if len(fake.resolved) != 2 || fake.resolved[0] != want[0] || fake.resolved[1] != want[1] {
		t.Fatalf("resolved = %v", fake.resolved)
	}
	if !a.ChatItems()[0].Allowed {
		t.Error("the allowed tool call is not marked")
	}
	a.Dispatch(NewSession{})
	a.onAgentEvent(permissionEvent("4", "e3", "edit"))
	if a.Permission() == nil {
		t.Fatal("a new session must ask again")
	}
}

// TestPlanAndToolDetailsReachTheView: the plan replaces itself, tool calls keep
// their kind, status and paths, and the turn is timed.
func TestPlanAndToolDetailsReachTheView(t *testing.T) {
	a, _ := newAgentTestApp(t)
	a.Replay("do it", 0,
		agent.Event{Kind: agent.EventPlan, Plan: []agent.PlanEntry{{Content: "a", Status: "in_progress"}}},
		agent.Event{Kind: agent.EventPlan, Plan: []agent.PlanEntry{{Content: "a", Status: "completed"}, {Content: "b", Status: "pending"}}},
		agent.Event{Kind: agent.EventTool, ToolCallID: "t", Title: "Read", KindDetail: "read", Text: "pending", Paths: []string{"main.go"}},
		agent.Event{Kind: agent.EventTool, ToolCallID: "t", Text: "completed"},
		agent.Event{Kind: agent.EventTurnEnd, StopReason: "end_turn"},
	)
	if p := a.Plan(); len(p) != 2 || p[0].Status != "completed" {
		t.Fatalf("plan = %+v", p)
	}
	var tool ChatItem
	for _, it := range a.ChatItems() {
		if it.Kind == agent.EventTool {
			tool = it
		}
	}
	if tool.ToolKind != "read" || tool.ToolStatus != "completed" || len(tool.Paths) != 1 {
		t.Fatalf("tool = %+v", tool)
	}
	if lt := a.LastTurn(); !lt.Done || lt.ToolCalls != 1 {
		t.Fatalf("last turn = %+v", lt)
	}
	if a.SessionTitle() != "do it" || a.Layout.Screen != ScreenSession {
		t.Fatalf("title %q screen %q", a.SessionTitle(), a.Layout.Screen)
	}
}

// TestPrefsSurviveARestart: the theme and the tasks come back from the store.
func TestPrefsSurviveARestart(t *testing.T) {
	t.Setenv("OMO_DATA_DIR", t.TempDir())
	t.Setenv("OMO_CONFIG_DIR", t.TempDir())
	a := New()
	if err := a.Restore(); err != nil {
		t.Fatal(err)
	}
	a.Dispatch(SetTheme{Mode: "dark"})
	a.Dispatch(NewTask{})
	a.taskDraft.Name, a.taskDraft.Prompt = "Nightly", "run tests"
	a.Dispatch(AddTask{})
	a.Shutdown()

	b := New()
	defer b.Shutdown()
	if err := b.Restore(); err != nil {
		t.Fatal(err)
	}
	if b.Prefs().Theme != "dark" || len(b.Prefs().Tasks) != 1 || b.Prefs().Tasks[0].Schedule != "schedWeekdays 09:00" {
		t.Fatalf("prefs = %+v", b.Prefs())
	}
}

// TestSearchFindsFilesAndCommands walks the workspace and the command table.
func TestSearchFindsFilesAndCommands(t *testing.T) {
	a, _ := newTestApp(t)
	hits := a.Search("a.go", 5)
	if len(hits) == 0 || hits[0].Kind != "file" || hits[0].Path != filepath.ToSlash("internal/a.go") {
		t.Fatalf("hits = %+v", hits)
	}
	found := false
	for _, h := range a.Search("settings", 5) {
		if h.Kind == "command" && h.Command == string(CmdSettings) {
			found = true
		}
	}
	if !found {
		t.Fatal("settings command not found")
	}
}

// TestAgentProcessesFollowTheState maps the active agent's state onto the
// sidebar's process rows.
func TestAgentProcessesFollowTheState(t *testing.T) {
	a, _ := newAgentTestApp(t)
	saveTestAgent(a)
	id := a.ActiveAgentID()
	for state, want := range map[agent.State]string{
		agent.StateReady: "idle", agent.StatePrompting: "running", agent.StateError: "failed", agent.StateDisconnected: "failed",
	} {
		a.onAgentEvent(agent.Event{Kind: agent.EventState, State: state})
		var got string
		for _, p := range a.AgentProcesses() {
			if p.ID == id {
				got = p.State
			}
		}
		// A failed agent stays marked until it is ready again.
		if state == agent.StateDisconnected && got != "failed" && got != "off" {
			t.Errorf("%s: %s", state, got)
			continue
		}
		if state != agent.StateDisconnected && got != want {
			t.Errorf("%s: got %s, want %s", state, got, want)
		}
	}
}
