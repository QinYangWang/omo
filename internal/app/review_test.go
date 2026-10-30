package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/QinYangWang/omo/internal/agent"
	"github.com/QinYangWang/omo/internal/diff"
)

// numbered builds a text of n lines, "line i".
func numbered(n int) string {
	var b strings.Builder
	for i := 1; i <= n; i++ {
		fmt.Fprintf(&b, "line %d\n", i)
	}
	return b.String()
}

func writeFile(t *testing.T, dir, rel, content string) {
	t.Helper()
	path := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, dir, rel string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// agentTouched is what the app sees when the agent reports a tool call on paths.
func agentTouched(a *App, paths ...string) {
	a.onAgentEvent(agent.Event{Kind: agent.EventTool, ToolCallID: "call-1", Paths: paths})
}

func TestAgentReviewCountsWhatTheAgentChanged(t *testing.T) {
	a, dir := newTestApp(t)
	original := numbered(20)
	writeFile(t, dir, "main.go", original)
	a.Dispatch(OpenWorkspace{Path: dir})

	agentTouched(a, "main.go")
	changed := strings.Replace(original, "line 1\n", "line 1 changed\n", 1)
	changed = strings.Replace(changed, "line 19\n", "line 19 changed\n", 1)
	writeFile(t, dir, "main.go", changed)

	a.Dispatch(OpenReview{})
	if n := a.AgentChangeCount(); n != 1 {
		t.Fatalf("changes = %d, want 1", n)
	}
	change := a.AgentChanges()[0]
	if change.Rel != "main.go" || change.Added != 2 || change.Deleted != 2 {
		t.Fatalf("change = %+v", change)
	}
	tab := a.TabAt(a.Layout.ActiveTab)
	if tab == nil || tab.Kind != TabReview {
		t.Fatalf("active tab = %+v, want the review list", tab)
	}
}

func TestAgentReviewPerHunkRevertWritesOnlyThatHunk(t *testing.T) {
	a, dir := newTestApp(t)
	original := numbered(20)
	writeFile(t, dir, "main.go", original)
	a.Dispatch(OpenWorkspace{Path: dir})

	agentTouched(a, "main.go")
	changed := strings.Replace(original, "line 1\n", "line 1 changed\n", 1)
	changed = strings.Replace(changed, "line 19\n", "line 19 changed\n", 1)
	writeFile(t, dir, "main.go", changed)
	a.Dispatch(OpenReview{})
	a.Dispatch(OpenDiff{Path: "main.go"})

	tab := a.TabAt(a.Layout.ActiveTab)
	if tab == nil || tab.Kind != TabDiff {
		t.Fatalf("active tab = %+v, want a diff", tab)
	}
	if hunks := tab.Diff.Hunks(); len(hunks) != 2 {
		t.Fatalf("hunks = %d, want 2", len(hunks))
	}
	tab.Diff.Revert(0)
	a.Dispatch(ApplyReview{})

	want := strings.Replace(original, "line 19\n", "line 19 changed\n", 1)
	if got := readFile(t, dir, "main.go"); got != want {
		t.Fatalf("disk after reverting hunk 0:\n%s\nwant:\n%s", got, want)
	}
	// The other hunk is still a change, so the review still lists the file.
	a.Dispatch(OpenReview{})
	if n := a.AgentChangeCount(); n != 1 {
		t.Fatalf("changes after the partial apply = %d, want 1", n)
	}
	if got := a.AgentChanges()[0]; got.Added != 1 || got.Deleted != 1 {
		t.Fatalf("remaining change = %+v", got)
	}
}

func TestAgentReviewRejectRestoresEveryFile(t *testing.T) {
	a, dir := newTestApp(t)
	original := "package main\n"
	writeFile(t, dir, "main.go", original)
	writeFile(t, dir, "second.go", "package main\n")
	a.Dispatch(OpenWorkspace{Path: dir})

	agentTouched(a, "main.go", "second.go", "added.go")
	writeFile(t, dir, "main.go", "package main // agent\n")
	writeFile(t, dir, "second.go", "package main\n\nfunc added() {}\n")
	writeFile(t, dir, "added.go", "package main\n")
	a.Dispatch(OpenReview{})
	if n := a.AgentChangeCount(); n != 3 {
		t.Fatalf("changes = %d, want 3", n)
	}
	for _, change := range a.AgentChanges() {
		if change.Added == 0 && change.Deleted == 0 {
			t.Errorf("change %q reports no lines", change.Rel)
		}
	}

	a.Dispatch(RejectReview{})
	if got := readFile(t, dir, "main.go"); got != original {
		t.Fatalf("main.go = %q, want the baseline", got)
	}
	if got := readFile(t, dir, "second.go"); got != original {
		t.Fatalf("second.go = %q, want the baseline", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "added.go")); !os.IsNotExist(err) {
		t.Fatalf("the file the agent created was not removed: %v", err)
	}
	if n := a.AgentChangeCount(); n != 0 {
		t.Fatalf("changes after the reject = %d, want 0", n)
	}
	if a.Notice().Key != "noticeReviewReverted" {
		t.Fatalf("notice = %q", a.Notice().Key)
	}
}

func TestAgentReviewAcceptKeepsTheNewBaseline(t *testing.T) {
	a, dir := newTestApp(t)
	writeFile(t, dir, "main.go", "one\n")
	a.Dispatch(OpenWorkspace{Path: dir})

	agentTouched(a, "main.go")
	writeFile(t, dir, "main.go", "two\n")
	a.Dispatch(OpenReview{})
	a.Dispatch(AcceptReview{})
	if n := a.AgentChangeCount(); n != 0 {
		t.Fatalf("changes after accept = %d, want 0", n)
	}
	if got := readFile(t, dir, "main.go"); got != "two\n" {
		t.Fatalf("disk = %q, want the agent's text", got)
	}
	// The next change is reviewed from what the file is now, not from "one".
	agentTouched(a, "main.go")
	writeFile(t, dir, "main.go", "three\n")
	a.refreshReview()
	if n := a.AgentChangeCount(); n != 1 {
		t.Fatalf("changes after the second edit = %d, want 1", n)
	}
	if got := a.AgentChanges()[0].Review.Old; got != "two\n" {
		t.Fatalf("baseline = %q, want the accepted text", got)
	}
}

func TestAgentReviewDegradesOverTheBudget(t *testing.T) {
	a, dir := newTestApp(t)
	writeFile(t, dir, "main.go", "0123456789\n")
	a.Dispatch(OpenWorkspace{Path: dir})
	a.baseline = diff.NewBaselineLimit(4)

	agentTouched(a, "main.go")
	if a.Notice().Key != "noticeReviewTooLarge" {
		t.Fatalf("notice = %q, want the degradation warning", a.Notice().Key)
	}
	a.refreshReview()
	if n := a.AgentChangeCount(); n != 0 {
		t.Fatalf("a file past the budget entered the review: %+v", a.AgentChanges())
	}
}

func TestAgentReviewSkipsPathsOutsideTheWorkspace(t *testing.T) {
	a, dir := newTestApp(t)
	writeFile(t, dir, "main.go", "one\n")
	a.Dispatch(OpenWorkspace{Path: dir})
	agentTouched(a, "<external>", "…", "")
	a.refreshReview()
	if n := a.AgentChangeCount(); n != 0 {
		t.Fatalf("changes = %+v, want none", a.AgentChanges())
	}
}

func TestRestoreReopensTheWorkspaceAndItsTabs(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("OMO_DATA_DIR", dataDir)
	workspace := t.TempDir()
	writeFile(t, workspace, "main.go", "package main\n")
	writeFile(t, workspace, "other.go", "package other\n")

	a := New()
	if err := a.Restore(); err != nil {
		t.Fatal(err)
	}
	a.Dispatch(OpenWorkspace{Path: workspace})
	a.Dispatch(OpenFile{Path: "main.go"})
	a.Dispatch(OpenFile{Path: "other.go"})
	a.Shutdown()

	b := New()
	if err := b.Restore(); err != nil {
		t.Fatal(err)
	}
	defer b.Shutdown()
	if b.WorkspacePath() != workspace {
		t.Fatalf("workspace = %q, want %q", b.WorkspacePath(), workspace)
	}
	if len(b.Tabs()) != 2 {
		t.Fatalf("tabs = %d, want 2", len(b.Tabs()))
	}
	if tab := b.TabAt(b.Layout.ActiveTab); tab == nil || tab.Rel != "other.go" {
		t.Fatalf("active tab = %+v, want other.go", tab)
	}
}

func TestRestoreRemembersTheAgentSession(t *testing.T) {
	t.Setenv("OMO_DATA_DIR", t.TempDir())
	workspace := t.TempDir()
	writeFile(t, workspace, "main.go", "package main\n")

	a := New()
	if err := a.Restore(); err != nil {
		t.Fatal(err)
	}
	a.Dispatch(OpenWorkspace{Path: workspace})
	a.activeAgentID = "agent-1"
	a.agents = &fakeAgentRuntime{state: agent.StateReady, sessionID: "acp-9", canLoad: true}
	a.persistSession()
	a.Shutdown()

	b := New()
	if err := b.Restore(); err != nil {
		t.Fatal(err)
	}
	defer b.Shutdown()
	if got := b.storedSession("agent-1"); got != "acp-9" {
		t.Fatalf("restored session = %q, want acp-9", got)
	}

	fake := &fakeAgentRuntime{state: agent.StateDisconnected}
	b.agents = fake
	b.activeAgentID = "agent-1"
	b.runAgent(agent.Definition{ID: "agent-1", Name: "t", Executable: "omo"}, "", false)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		fake.mu.Lock()
		got := fake.restoreID
		fake.mu.Unlock()
		if got == "acp-9" {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the agent was not asked to restore the stored session")
}

func TestRestoreWithoutAStoreIsSafe(t *testing.T) {
	t.Setenv("OMO_DATA_DIR", filepath.Join(t.TempDir(), "nested", "omo"))
	a := New()
	defer a.Shutdown()
	if err := a.Restore(); err != nil {
		t.Fatalf("Restore = %v", err)
	}
	if err := a.Restore(); err != nil {
		t.Fatalf("second Restore = %v", err)
	}
	if a.Notice().Key == "noticeStoreFailed" {
		t.Fatalf("notice = %q", a.Notice().Key)
	}
}
