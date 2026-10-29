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
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n"), 0o644); err != nil {
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

func TestIconsParse(t *testing.T) {
	for name, icon := range map[string]*ui.SVG{
		"files": iconFiles, "search": iconSearch, "git": iconGit, "terminal": iconTerminal,
	} {
		if icon == nil {
			t.Errorf("icon %q did not parse", name)
		}
	}
}

func TestShellRendersEveryRegion(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := newTester(t, a)
	tt.Frame()

	for _, want := range []string{
		"Explorer", "Chat", "Panel", "main.go", "internal",
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
	if !tt.HasText("Open Workspace…") {
		t.Errorf("welcome screen missing; texts = %v", tt.Texts())
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

func TestZhLocaleRenders(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := ui.NewTester(func(c *ui.Context) { Shell(c, a) }, 1400, 860)
	tt.SetLocale("zh-Hans")
	tt.Frame()
	if !tt.HasText("资源管理器") {
		t.Errorf("zh-Hans catalog not used; texts = %v", tt.Texts())
	}
	if !tt.HasText("未打开工作区") && !tt.HasText("面板") {
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

	// The git rail entry switches the side panel to Changes.
	a.Layout.ActivitySel = "git"
	tt.Frame()
	if !tt.HasText("1 change") {
		t.Errorf("changes count missing; texts = %v", tt.Texts())
	}
	if !tt.HasText("main.go") || !tt.HasText("M") {
		t.Errorf("changed path or status missing from the panel; texts = %v", tt.Texts())
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

// TestActivityRailSwitchesPanels clicks the icon rail itself. The coordinates
// depend on the theme's row height, so a spacing change fails loudly here rather
// than silently breaking navigation.
func TestActivityRailSwitchesPanels(t *testing.T) {
	a, _ := newWorkspaceApp(t)
	tt := newTester(t, a)
	tt.Frame()

	if a.Layout.ActivitySel != "explorer" {
		t.Fatalf("rail starts on %q", a.Layout.ActivitySel)
	}
	tt.ClickAt(20, 70) // second icon
	tt.Frame()
	if a.Layout.ActivitySel != "search" {
		t.Fatalf("second rail item = %q, want search", a.Layout.ActivitySel)
	}
	tt.ClickAt(20, 120) // third icon
	tt.Frame()
	if a.Layout.ActivitySel != "git" {
		t.Fatalf("third rail item = %q, want git", a.Layout.ActivitySel)
	}
	tt.ClickAt(20, 20) // back to the first
	tt.Frame()
	if a.Layout.ActivitySel != "explorer" {
		t.Fatalf("first rail item = %q, want explorer", a.Layout.ActivitySel)
	}
}
