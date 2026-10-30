package view

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/QinYangWang/omo/internal/app"
	"github.com/egoist/mygo/ui"
)

func newTester(t *testing.T, a *app.App) *ui.Tester {
	t.Helper()
	tt := ui.NewTester(func(c *ui.Context) { Shell(c, a) }, 1400, 860)
	tt.SetLocale("en")
	return tt
}

// newWorkspaceApp opens a temporary directory as the workspace.
func newWorkspaceApp(t *testing.T) (*app.App, string) {
	t.Helper()
	t.Setenv("OMO_CONFIG_DIR", t.TempDir())
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "internal"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "internal", "a.go"), []byte("package internal\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := app.New()
	a.Dispatch(app.OpenWorkspace{Path: dir})
	t.Cleanup(a.Shutdown)
	return a, dir
}

func TestShellRendersEveryRegion(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := newTester(t, a)
	tt.Frame()

	for _, want := range []string{
		"Sessions", "Files", "Sidebar", "main.go", "internal", "What are we building?",
	} {
		if !tt.HasText(want) {
			t.Errorf("missing %q; texts = %v", want, tt.Texts())
		}
	}
	if !tt.HasText("no git") {
		t.Errorf("status bar should say the directory is not a repository; texts = %v", tt.Texts())
	}

	// The bottom panel is closed at startup; opening it reveals its pages.
	if err := tt.Click("Panel"); err != nil {
		t.Fatalf("click Panel: %v", err)
	}
	tt.Frame()
	for _, want := range []string{"Terminal", "Problems", "Output"} {
		if !tt.HasText(want) {
			t.Errorf("missing bottom panel tab %q; texts = %v", want, tt.Texts())
		}
	}
}

func TestClickFileOpensTabAndShowsCaret(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := newTester(t, a)
	tt.Frame()

	if err := tt.Click("main.go"); err != nil {
		t.Fatalf("click main.go: %v", err)
	}
	tt.Frame()
	if a.ActiveTab() != 0 || a.TabAt(0).Rel != "main.go" {
		t.Fatalf("ActiveTab=%d", a.ActiveTab())
	}
	if !tt.HasText("Ln 1, Col 1") {
		t.Errorf("status bar lacks the caret position; texts = %v", tt.Texts())
	}
	if !tt.HasText("Go") {
		t.Errorf("status bar lacks the language; texts = %v", tt.Texts())
	}
	if !tt.HasText("LF") {
		t.Errorf("status bar lacks the line ending; texts = %v", tt.Texts())
	}
}

// TestSessionTabReturnsHome checks the strip's first tab: the session pane, back
// from any open document.
func TestSessionTabReturnsHome(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := newTester(t, a)
	tt.Frame()
	if err := tt.Click("main.go"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if tt.HasText("What are we building?") {
		t.Fatal("the session pane is still drawn over the editor")
	}
	if err := tt.Click("Session"); err != nil {
		t.Fatalf("click session tab: %v", err)
	}
	tt.Frame()
	if a.ActiveTab() != -1 {
		t.Fatalf("ActiveTab = %d, want none", a.ActiveTab())
	}
	if !tt.HasText("What are we building?") {
		t.Errorf("the session pane is not back; texts = %v", tt.Texts())
	}
}

func TestDirtyFileIsMarkedAndCloseReturnsToWelcome(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := newTester(t, a)
	tt.Frame()
	if err := tt.Click("main.go"); err != nil {
		t.Fatal(err)
	}
	a.TabAt(0).Editor.Buffer.Set("package main // edited\n")
	tt.Frame()
	if !tt.HasText("●") {
		t.Errorf("tree does not mark the file dirty; texts = %v", tt.Texts())
	}
	if err := tt.Click("×"); err != nil {
		t.Fatalf("click close: %v", err)
	}
	tt.Frame()
	if len(a.Tabs()) != 0 {
		t.Fatalf("tabs = %d after closing", len(a.Tabs()))
	}
	if !tt.HasText("What are we building?") {
		t.Errorf("the session window should be back; texts = %v", tt.Texts())
	}
}

func TestPanelToggleShowsTerminalPage(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := newTester(t, a)
	tt.Frame()
	if a.PanelOpen() {
		t.Fatal("panel starts open")
	}
	if err := tt.Click("Panel"); err != nil {
		t.Fatalf("click Panel: %v", err)
	}
	tt.Frame()
	if !a.PanelOpen() {
		t.Fatal("panel did not open")
	}
	if !tt.HasText("No terminal open.") {
		t.Errorf("terminal page missing; texts = %v", tt.Texts())
	}
	if err := tt.Click("Hide"); err != nil {
		t.Fatalf("click Hide: %v", err)
	}
	tt.Frame()
	if a.PanelOpen() {
		t.Fatal("panel did not close")
	}
}

func TestConflictDialogShowsAndResolves(t *testing.T) {
	a, dir := newWorkspaceApp(t)
	tt := newTester(t, a)
	tt.Frame()
	if err := tt.Click("main.go"); err != nil {
		t.Fatal(err)
	}
	a.TabAt(0).Editor.Buffer.Set("package main // mine\n")
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main // agent\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a.Dispatch(app.SaveFile{})
	tt.Frame()
	if !tt.HasText("File changed on disk") {
		t.Fatalf("conflict dialog missing; texts = %v", tt.Texts())
	}
	if err := tt.Click("Reload from disk"); err != nil {
		t.Fatalf("click reload: %v", err)
	}
	tt.Frame()
	if a.ConflictOpen() {
		t.Fatal("dialog still open")
	}
	if got := a.TabAt(0).Editor.Buffer.String(); got != "package main // agent\n" {
		t.Fatalf("buffer = %q", got)
	}
}

func TestAgentConfigurationRequiresExplicitTrust(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := newTester(t, a)
	tt.Frame()
	if err := tt.Click("Add agent"); err != nil {
		t.Fatalf("click Add agent: %v", err)
	}
	tt.Frame()
	if !tt.HasText("Configure ACP agent") {
		t.Fatalf("configuration dialog missing: %v", tt.Texts())
	}
	a.AgentConfigForm().Name = "Helper"
	a.AgentConfigForm().Executable = os.Args[0]
	a.AgentConfigForm().Args = "--acp"
	a.Dispatch(app.SaveAgentConfig{})
	a.Dispatch(app.StartAgent{ID: a.ActiveAgentID()})
	tt.Frame()
	for _, want := range []string{"Trust this agent?", os.Args[0], "--acp", a.WorkspacePath()} {
		if !tt.HasText(want) {
			t.Errorf("trust dialog missing %q; texts = %v", want, tt.Texts())
		}
	}
}

func TestZhLocaleRenders(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := ui.NewTester(func(c *ui.Context) { Shell(c, a) }, 1400, 860)
	tt.SetLocale("zh-Hans")
	tt.Frame()
	if !tt.HasText("会话") {
		t.Errorf("zh-Hans catalog not used; texts = %v", tt.Texts())
	}
	if !tt.HasText("侧栏") && !tt.HasText("面板") {
		t.Errorf("status bar not translated; texts = %v", tt.Texts())
	}
}

// newGitRepo makes a repository with one committed file, then modifies it.
func newGitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "--initial-branch=main", "."}, {"add", "."}, {"commit", "-m", "initial"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com",
			"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\nfunc main() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestGitPanelListsChangeAndReviewReverts(t *testing.T) {
	dir := newGitRepo(t)
	a := app.New()
	a.Dispatch(app.OpenWorkspace{Path: dir})
	defer a.Shutdown()

	tt := newTester(t, a)
	tt.Frame()

	// The git sidebar page lists the changed path.
	a.Layout.RightSel = "git"
	tt.Frame()
	if !tt.HasText("1 change") {
		t.Errorf("changes count missing; texts = %v", tt.Texts())
	}
	if !tt.HasText("main.go") || !tt.HasText("M") {
		t.Errorf("changed path or status missing from the panel; texts = %v", tt.Texts())
	}

	// Stage all, then the status bar says so and the change reports staged.
	if err := tt.Click("Stage all changes"); err != nil {
		t.Fatalf("click stage: %v", err)
	}
	tt.Frame()
	if !tt.HasText("Staged 1 file") {
		t.Errorf("staging result missing; texts = %v", tt.Texts())
	}
	if changes := a.Changes(); len(changes) != 1 || !changes[0].Staged {
		t.Fatalf("changes after stage = %v, want one staged", changes)
	}

	a.Dispatch(app.OpenDiff{Path: "main.go"})
	tt.Frame()
	tab := a.TabAt(a.ActiveTab())
	if tab == nil || tab.Kind != app.TabDiff {
		t.Fatalf("diff tab not opened: %+v", tab)
	}
	if !tt.HasText("Diff: main.go") {
		t.Errorf("diff tab title missing; texts = %v", tt.Texts())
	}
	if !tt.HasText("Apply review") {
		t.Errorf("review toolbar missing; texts = %v", tt.Texts())
	}

	// Revert the only hunk, then apply: the file goes back to its HEAD text.
	if hunks := tab.Diff.Hunks(); len(hunks) == 0 {
		t.Fatal("no hunks to review")
	}
	tab.Diff.Revert(0)
	if err := tt.Click("Apply review"); err != nil {
		t.Fatalf("click apply: %v", err)
	}
	tt.Frame()
	onDisk, err := os.ReadFile(filepath.Join(dir, "main.go"))
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != "package main\n" {
		t.Fatalf("disk = %q, want the HEAD text back", onDisk)
	}
}

// TestRightSidebarSwitchesPages clicks the sidebar's icon strip, by the label
// each icon gives itself.
func TestRightSidebarSwitchesPages(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := newTester(t, a)
	tt.Frame()

	if a.Layout.RightSel != "files" {
		t.Fatalf("the sidebar starts on %q", a.Layout.RightSel)
	}
	if err := tt.Click("Search"); err != nil {
		t.Fatalf("click search: %v", err)
	}
	tt.Frame()
	if a.Layout.RightSel != "search" {
		t.Fatalf("second icon = %q, want search", a.Layout.RightSel)
	}
	if err := tt.Click("Changes"); err != nil {
		t.Fatalf("click changes: %v", err)
	}
	tt.Frame()
	if a.Layout.RightSel != "git" {
		t.Fatalf("third icon = %q, want git", a.Layout.RightSel)
	}
	if err := tt.Click("Files"); err != nil {
		t.Fatalf("click files: %v", err)
	}
	tt.Frame()
	if a.Layout.RightSel != "files" {
		t.Fatalf("first icon = %q, want files", a.Layout.RightSel)
	}
}

// TestRunPageOffersTheWorkspaceQuickCommands checks the run page of a Go
// workspace: build, test and vet, each a terminal command.
func TestRunPageOffersTheWorkspaceQuickCommands(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := newTester(t, a)
	tt.Frame()

	if err := tt.Click("Run and Debug"); err != nil {
		t.Fatalf("click run: %v", err)
	}
	tt.Frame()
	if a.Layout.RightSel != "run" {
		t.Fatalf("page = %q, want run", a.Layout.RightSel)
	}
	for _, want := range []string{"Build", "Test", "Vet", "go build ./...", "go test ./..."} {
		if !tt.HasText(want) {
			t.Errorf("missing %q; texts = %v", want, tt.Texts())
		}
	}
}

// TestHeaderTogglesCollapseTheSidebars checks the two header buttons: each one
// hides and shows its column.
func TestHeaderTogglesCollapseTheSidebars(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := newTester(t, a)
	tt.Frame()

	if err := tt.Click("Toggle Sessions"); err != nil {
		t.Fatalf("click sessions toggle: %v", err)
	}
	tt.Frame()
	if a.LeftOpen() {
		t.Fatal("the sessions panel is still open")
	}
	if err := tt.Click("Toggle Sidebar"); err != nil {
		t.Fatalf("click sidebar toggle: %v", err)
	}
	tt.Frame()
	if a.RightOpen() {
		t.Fatal("the right sidebar is still open")
	}
	if !tt.HasText("What are we building?") {
		t.Errorf("the middle column did not take the room; texts = %v", tt.Texts())
	}
}
