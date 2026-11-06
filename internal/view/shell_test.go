package view

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/QinYangWang/omo/internal/agent"
	"github.com/QinYangWang/omo/internal/app"
	"github.com/egoist/mygo/ui"
)

func newTester(t *testing.T, a *app.App) *ui.Tester {
	t.Helper()
	tt := ui.NewTester(func(c *ui.Context) { Shell(c, a) }, 1280, 800)
	tt.SetLocale("en")
	return tt
}

// newWorkspaceApp opens a temporary directory as the workspace.
func newWorkspaceApp(t *testing.T) (*app.App, string) {
	t.Helper()
	t.Setenv("OMO_CONFIG_DIR", t.TempDir())
	dir := t.TempDir()
	for name, body := range map[string]string{
		"main.go":       "package main\n",
		"go.mod":        "module example\n",
		"internal/a.go": "package internal\n",
	} {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	a := app.New()
	a.Dispatch(app.OpenWorkspace{Path: dir})
	t.Cleanup(a.Shutdown)
	return a, dir
}

// addAgent configures an agent that runs this test binary; nothing starts
// before the user trusts it.
func addAgent(t *testing.T, a *app.App, id, name string) {
	t.Helper()
	a.Dispatch(app.EditAgentConfig{})
	d := a.AgentConfigForm()
	d.ID, d.Name, d.Executable, d.Args = id, name, os.Args[0], "--acp"
	a.Dispatch(app.SaveAgentConfig{})
}

func click(t *testing.T, tt *ui.Tester, label string) {
	t.Helper()
	if err := tt.Click(label); err != nil {
		t.Fatalf("click %q: %v; texts = %v", label, err, tt.Texts())
	}
	tt.Frame()
}

func wantTexts(t *testing.T, tt *ui.Tester, texts ...string) {
	t.Helper()
	for _, want := range texts {
		if !tt.HasText(want) {
			t.Errorf("missing %q; texts = %v", want, tt.Texts())
		}
	}
}

// TestHomeShowsTheConsole checks the new-session screen: the sidebar's
// actions, the project, the local agents and the composer.
func TestHomeShowsTheConsole(t *testing.T) {
	a, dir := newWorkspaceApp(t)
	addAgent(t, a, "claude", "Claude Code")
	tt := newTester(t, a)
	tt.Frame()
	wantTexts(t, tt, "omo", "New session", "Search", "Scheduled tasks", "Projects", filepath.Base(dir),
		"Local agents", "Claude Code", "Not started", "Which agent takes this on today?", "/review")
}

// TestSendWithoutAgentAsksToChoose: with no agent the composer's pill says so.
func TestSendWithoutAgentAsksToChoose(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := newTester(t, a)
	tt.Frame()
	wantTexts(t, tt, "Choose an agent")
	click(t, tt, "Choose agent")
	wantTexts(t, tt, "ACP agents", "Session mode")
}

// TestQuickPromptFillsTheComposer: a "/" chip puts its text in the composer.
func TestQuickPromptFillsTheComposer(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := newTester(t, a)
	tt.Frame()
	click(t, tt, "/review")
	if got := *a.AgentInput(); !strings.Contains(got, "main") {
		t.Fatalf("composer = %q", got)
	}
}

// TestSessionShowsPlanToolsAndApproval replays an ACP session and checks the
// conversation, the folded reads, the inspector's plan and the inline
// approval with its three answers.
func TestSessionShowsPlanToolsAndApproval(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	addAgent(t, a, "claude", "Claude Code")
	a.Dispatch(app.SelectAgent{ID: "claude"})
	a.Replay("Move the docs to Pages", 20*time.Second,
		agent.Event{Kind: agent.EventState, State: agent.StatePrompting},
		agent.Event{Kind: agent.EventPlan, Plan: []agent.PlanEntry{
			{Content: "Read the workflow", Status: "completed"},
			{Content: "Rewrite deploy.yml", Status: "in_progress"},
			{Content: "Build locally", Status: "pending"},
		}},
		agent.Event{Kind: agent.EventTool, ToolCallID: "r1", KindDetail: "read", Text: "completed", Paths: []string{"a.yml"}},
		agent.Event{Kind: agent.EventTool, ToolCallID: "r2", KindDetail: "read", Text: "completed", Paths: []string{"b.yml"}},
		agent.Event{Kind: agent.EventTool, ToolCallID: "x1", KindDetail: "execute", Text: "completed", Command: []string{"go", "test", "./..."}},
		agent.Event{Kind: agent.EventPermission, RequestID: "1-1", ToolCallID: "e1", KindDetail: "edit", Title: "Rewrite deploy.yml",
			Paths: []string{"main.go"}, Options: []agent.PermissionOption{
				{ID: "allow", Kind: "allow_once"}, {ID: "always", Kind: "allow_always"}, {ID: "no", Kind: "reject_once"},
			}},
	)
	tt := newTester(t, a)
	tt.Frame()
	wantTexts(t, tt, "Move the docs to Pages", "Waiting for approval", "Plan", "1 / 3", "Rewrite deploy.yml",
		"go test ./...", "Allow once", "Always allow in this session", "Deny", "The agent is waiting")
	if !tt.HasText("Read 2 files, searched 0 times") {
		t.Errorf("consecutive reads are not folded; texts = %v", tt.Texts())
	}
	// allow_always is never offered as such: the session grant is omo's own.
	if tt.HasText("Always") && !tt.HasText("Always allow in this session") {
		t.Error("allow_always leaked")
	}
}

// TestErrorCardOffersThreeWaysOn: a failed start shows the cause and the
// three fixes; the switch names the other agent.
func TestErrorCardOffersThreeWaysOn(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	addAgent(t, a, "gemini", "Gemini CLI")
	addAgent(t, a, "codex", "Codex")
	a.Dispatch(app.SelectAgent{ID: "gemini"})
	a.Replay("Add tests", 0,
		agent.Event{Kind: agent.EventDiagnostic, Text: "login expired"},
		agent.Event{Kind: agent.EventState, State: agent.StateError},
	)
	tt := newTester(t, a)
	tt.Frame()
	wantTexts(t, tt, "Gemini CLI could not start", "login expired", "Sign in to Gemini CLI again", "Retry",
		"Continue with Codex", "Not connected", "Failed to start")
}

// TestSidePanelSwitchesPages checks the 520 DIP panel: changes, files and
// terminal, and that closing it brings the inspector back.
func TestSidePanelSwitchesPages(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	a.Replay("Look around", 0, agent.Event{Kind: agent.EventTurnEnd, StopReason: "end_turn"})
	tt := newTester(t, a)
	tt.Frame()
	wantTexts(t, tt, "Plan", "This session", "Done")
	click(t, tt, "Changes")
	wantTexts(t, tt, "Changes 0", "No changes yet")
	click(t, tt, "Files")
	click(t, tt, "main.go")
	if tab := a.TabAt(a.Layout.ActiveTab); tab == nil || tab.Rel != "main.go" {
		t.Fatalf("main.go is not previewed")
	}
	click(t, tt, "Terminal")
	wantTexts(t, tt, "No terminal yet", "New Terminal")
	click(t, tt, "Close panel")
	wantTexts(t, tt, "This session")
}

// TestAgentChangesListAndDiff: what the agent wrote is listed with its counts
// and opens as a diff in the panel.
func TestAgentChangesListAndDiff(t *testing.T) {
	a, dir := newWorkspaceApp(t)
	a.NoteAgentPaths("main.go")
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\nfunc main() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a.Replay("Add main", 0, agent.Event{Kind: agent.EventTurnEnd, StopReason: "end_turn"})
	tt := newTester(t, a)
	tt.Frame()
	wantTexts(t, tt, "+2", "−0")
	click(t, tt, "All changes")
	click(t, tt, "main.go")
	wantTexts(t, tt, "Modified", "Revert all", "Keep all")
	if !tt.HasText("Commit") && a.Branch() != "" {
		t.Errorf("commit action missing in a repository")
	}
}

// TestSearchFindsFilesAndSaysWhenNothingMatches checks both palettes.
func TestSearchFindsFilesAndSaysWhenNothingMatches(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	addAgent(t, a, "claude", "Claude Code")
	tt := newTester(t, a)
	tt.Frame()
	click(t, tt, "Search")
	a.Layout.SearchQuery = "a.go"
	tt.Frame()
	wantTexts(t, tt, "Files")
	if !strings.Contains(strings.Join(tt.Texts(), "|"), "a.go") {
		t.Errorf("file hit missing; texts = %v", tt.Texts())
	}
	a.Layout.SearchQuery = "nothing-like-this"
	tt.Frame()
	wantTexts(t, tt, "Nothing found for “nothing-like-this”", "Ask Claude Code about “nothing-like-this”")
}

// TestScheduledTaskCreateAndPause adds a task through the form and pauses it.
func TestScheduledTaskCreateAndPause(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	addAgent(t, a, "claude", "Claude Code")
	tt := newTester(t, a)
	tt.Frame()
	click(t, tt, "Scheduled tasks")
	wantTexts(t, tt, "No scheduled tasks")
	click(t, tt, "New task")
	d := a.TaskDraft()
	d.Name, d.Prompt = "Nightly", "Run the tests"
	tt.Frame()
	click(t, tt, "Create task")
	if tasks := a.Prefs().Tasks; len(tasks) != 1 || !tasks[0].Enabled || tasks[0].AgentID != "claude" {
		t.Fatalf("tasks = %+v", tasks)
	}
	wantTexts(t, tt, "Nightly", "Weekdays 09:00")
	click(t, tt, "Turn Nightly on or off")
	if a.Prefs().Tasks[0].Enabled {
		t.Fatal("task still enabled")
	}
}

// TestSettingsPagesOpenAndThemeSwitches walks the settings navigation and the
// appearance cards.
func TestSettingsPagesOpenAndThemeSwitches(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := newTester(t, a)
	tt.Frame()
	click(t, tt, "Settings")
	wantTexts(t, tt, "Preferences", "New sessions")
	for _, page := range []string{"General", "Shortcuts", "Agents", "Agent roles", "Memory", "MCP servers",
		"Quick commands", "Projects", "GitHub", "Sharing", "AI usage", "About omo"} {
		click(t, tt, page)
	}
	click(t, tt, "Appearance")
	click(t, tt, "Dark")
	if a.Prefs().Theme != "dark" {
		t.Fatalf("theme = %q", a.Prefs().Theme)
	}
	click(t, tt, "Close")
	if a.Layout.Settings {
		t.Fatal("settings still open")
	}
}

func TestAgentsSettingsOfferUpdateForDetectedCLI(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	// A known adapter on PATH is found at startup, as main.go does it.
	name := "codex-acp"
	if runtime.GOOS == "windows" {
		name += ".cmd"
	}
	bin := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Dir(bin)+string(os.PathListSeparator)+os.Getenv("PATH"))
	a.DetectAgents()

	tt := newTester(t, a)
	tt.Frame()
	click(t, tt, "Agents")
	// A detected agent can be updated, because its npm package is known.
	wantTexts(t, tt, "Update CLI", "Launch command")
}

func TestAgentConfigurationRequiresExplicitTrust(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := newTester(t, a)
	tt.Frame()
	click(t, tt, "Add agent")
	wantTexts(t, tt, "Configure ACP agent")
	addAgent(t, a, "helper", "Helper")
	a.Dispatch(app.StartAgent{ID: "helper"})
	tt.Frame()
	wantTexts(t, tt, "Start Helper in "+a.WorkspaceName()+" for the first time", "Trust and start")
	if !strings.Contains(strings.Join(tt.Texts(), "|"), "--acp") {
		t.Errorf("trust dialog does not show the arguments; texts = %v", tt.Texts())
	}
}

func TestConflictDialogShowsAndResolves(t *testing.T) {
	a, dir := newWorkspaceApp(t)
	a.Dispatch(app.OpenFile{Path: "main.go"})
	a.TabAt(0).Editor.Buffer.Set("package main // mine\n")
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main // agent\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a.Dispatch(app.SaveFile{})
	tt := newTester(t, a)
	tt.Frame()
	wantTexts(t, tt, "File changed on disk")
	click(t, tt, "Reload from disk")
	if a.ConflictOpen() {
		t.Fatal("dialog still open")
	}
	if got := a.TabAt(0).Editor.Buffer.String(); got != "package main // agent\n" {
		t.Fatalf("buffer = %q", got)
	}
}

func TestZhLocaleRenders(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := ui.NewTester(func(c *ui.Context) { Shell(c, a) }, 1280, 800)
	tt.SetLocale("zh-Hans")
	tt.Frame()
	wantTexts(t, tt, "新会话", "定时任务", "本机 Agent", "今天让哪个 Agent 动手？")
}

func TestSidebarCollapses(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := newTester(t, a)
	tt.Frame()
	click(t, tt, "Show or hide the sidebar")
	if a.LeftOpen() || tt.HasText("Local agents") {
		t.Fatal("sidebar still shown")
	}
}

func TestStageAndCommitFromTheChangesPanel(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	a, dir := newWorkspaceApp(t)
	for _, args := range [][]string{{"init", "-q", "--initial-branch=main"}, {"add", "."}, {"commit", "-qm", "init"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e", "GIT_COMMITTER_NAME=t",
			"GIT_COMMITTER_EMAIL=t@e", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	t.Setenv("GIT_AUTHOR_NAME", "t")
	t.Setenv("GIT_AUTHOR_EMAIL", "t@e")
	t.Setenv("GIT_COMMITTER_NAME", "t")
	t.Setenv("GIT_COMMITTER_EMAIL", "t@e")
	// The repository is found when the workspace opens.
	a.Dispatch(app.OpenWorkspace{Path: dir})
	a.NoteAgentPaths("main.go")
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\n// changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a.Replay("Change main", 0, agent.Event{Kind: agent.EventTurnEnd, StopReason: "end_turn"})
	a.Dispatch(app.ToggleSidePanel{Name: app.PanelChanges})
	a.Layout.CommitMsg = "change main"
	tt := newTester(t, a)
	tt.Frame()
	click(t, tt, "Commit")
	out, err := exec.Command("git", "-C", dir, "log", "--format=%s", "-1").Output()
	if err != nil || strings.TrimSpace(string(out)) != "change main" {
		t.Fatalf("last commit = %q, %v", out, err)
	}
}
