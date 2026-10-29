package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/QinYangWang/omo/internal/commands"
)

// newTestApp builds an app with a small real workspace: mkdir, files, no repo.
func newTestApp(t *testing.T) (*App, string) {
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
	a := New()
	a.Dispatch(OpenWorkspace{Path: dir})
	t.Cleanup(a.Shutdown)
	return a, dir
}

func TestNewStartsWithNothingOpen(t *testing.T) {
	a := New()
	defer a.Shutdown()
	if got := a.ActiveTab(); got != -1 {
		t.Fatalf("ActiveTab = %d, want -1", got)
	}
	if a.PanelOpen() {
		t.Error("bottom panel should start closed")
	}
	if a.Notice().Key != "noticeReady" {
		t.Errorf("initial notice = %q", a.Notice().Key)
	}
	if a.WorkspaceName() != "" {
		t.Errorf("workspace = %q, want none", a.WorkspaceName())
	}
}

func TestOpenFileNeedsAWorkspace(t *testing.T) {
	a := New()
	defer a.Shutdown()
	a.Dispatch(OpenFile{Path: "main.go"})
	if a.Notice().Key != "noticeNeedWorkspace" {
		t.Fatalf("notice = %q", a.Notice().Key)
	}
	if len(a.Tabs()) != 0 {
		t.Fatal("a file opened without a workspace")
	}
}

func TestOpenWorkspaceListsFilesAndReplacesPrevious(t *testing.T) {
	a, dir := newTestApp(t)
	if a.WorkspaceName() != filepath.Base(dir) {
		t.Fatalf("workspace = %q", a.WorkspaceName())
	}
	if len(a.Files()) != 2 {
		t.Fatalf("root entries = %d, want 2", len(a.Files()))
	}
	// Directories sort first.
	if !a.Files()[0].IsDir || a.Files()[0].Name != "internal" {
		t.Fatalf("root = %+v", a.Files()[0])
	}
	// Children load lazily.
	internal := a.Files()[0]
	if internal.Loaded {
		t.Error("directory loaded before it was opened")
	}
	a.LoadChildren(internal)
	if !internal.Loaded || len(internal.Children) != 1 || internal.Children[0].Name != "a.go" {
		t.Fatalf("children = %+v", internal.Children)
	}

	// Opening another workspace drops documents and tabs.
	a.Dispatch(OpenFile{Path: "main.go"})
	if len(a.Tabs()) != 1 {
		t.Fatal("file did not open")
	}
	a.Dispatch(OpenWorkspace{Path: t.TempDir()})
	if len(a.Tabs()) != 0 || a.Files() == nil {
		t.Fatal("previous workspace state survived the switch")
	}
}

func TestOpenFileIsIdempotentPerPath(t *testing.T) {
	a, _ := newTestApp(t)
	a.Dispatch(OpenFile{Path: "main.go"})
	a.Dispatch(OpenFile{Path: "internal/a.go"})
	a.Dispatch(OpenFile{Path: "main.go"})
	if len(a.Tabs()) != 2 {
		t.Fatalf("tabs = %d, want 2", len(a.Tabs()))
	}
	if a.ActiveTab() != 0 {
		t.Fatalf("ActiveTab = %d, want 0", a.ActiveTab())
	}
	if line, col, ok := a.CursorLineCol(); !ok || line != 1 || col != 1 {
		t.Fatalf("cursor = %d:%d ok=%v", line, col, ok)
	}
	if a.LanguageName() == "" {
		t.Error("language not detected")
	}
	if eol := a.LineEnding(); eol != "LF" {
		t.Errorf("line ending = %q", eol)
	}
}

func TestSaveWritesAndClearsDirty(t *testing.T) {
	a, dir := newTestApp(t)
	a.Dispatch(OpenFile{Path: "main.go"})
	tab := a.TabAt(a.ActiveTab())
	tab.Editor.Buffer.Set("package main // edited\n")
	if !a.Dirty("main.go") {
		t.Fatal("edit did not mark the file dirty")
	}
	a.Dispatch(SaveFile{})
	if a.Dirty("main.go") {
		t.Fatal("save did not clear the dirty flag")
	}
	if a.Notice().Key != "noticeFileSaved" {
		t.Errorf("notice = %q", a.Notice().Key)
	}
	data, err := os.ReadFile(filepath.Join(dir, "main.go"))
	if err != nil || string(data) != "package main // edited\n" {
		t.Fatalf("disk = %q, %v", data, err)
	}
}

func TestSaveConflictOpensDialogAndReloadResolves(t *testing.T) {
	a, dir := newTestApp(t)
	a.Dispatch(OpenFile{Path: "main.go"})
	a.TabAt(a.ActiveTab()).Editor.Buffer.Set("package main // mine\n")
	// An agent writes the file through the terminal.
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main // agent\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a.Dispatch(SaveFile{})
	if !a.ConflictOpen() || a.ConflictPath() != "main.go" {
		t.Fatalf("conflict = %v %q", a.ConflictOpen(), a.ConflictPath())
	}
	onDisk, _ := os.ReadFile(filepath.Join(dir, "main.go"))
	if string(onDisk) != "package main // agent\n" {
		t.Fatalf("save overwrote the agent's write: %q", onDisk)
	}

	a.Dispatch(ResolveConflict{Choice: ConflictReload})
	if a.ConflictOpen() {
		t.Error("dialog still open after reload")
	}
	if a.Dirty("main.go") {
		t.Error("buffer still dirty after reloading from disk")
	}
	if got := a.TabAt(a.ActiveTab()).Editor.Buffer.String(); got != "package main // agent\n" {
		t.Fatalf("buffer = %q", got)
	}
}

func TestConflictOverwriteKeepsTheBuffer(t *testing.T) {
	a, dir := newTestApp(t)
	a.Dispatch(OpenFile{Path: "main.go"})
	a.TabAt(a.ActiveTab()).Editor.Buffer.Set("package main // mine\n")
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main // agent\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a.Dispatch(SaveFile{})
	a.Dispatch(ResolveConflict{Choice: ConflictOverwrite})
	data, _ := os.ReadFile(filepath.Join(dir, "main.go"))
	if string(data) != "package main // mine\n" {
		t.Fatalf("disk = %q, want the buffer", data)
	}
}

func TestCloseTabClampsSelection(t *testing.T) {
	a, _ := newTestApp(t)
	a.Dispatch(OpenFile{Path: "main.go"})
	a.Dispatch(OpenFile{Path: "internal/a.go"})
	a.Dispatch(CloseTab{Index: 1})
	if len(a.Tabs()) != 1 || a.ActiveTab() != 0 {
		t.Fatalf("tabs=%d active=%d", len(a.Tabs()), a.ActiveTab())
	}
	a.Dispatch(CloseTab{Index: 0})
	if a.ActiveTab() != -1 {
		t.Fatalf("ActiveTab = %d with no tabs", a.ActiveTab())
	}
	a.Dispatch(CloseTab{Index: 9}) // ignored, not a panic
}

func TestTogglePanelAndCommands(t *testing.T) {
	a, _ := newTestApp(t)
	open := a.PanelOpen()
	a.Dispatch(TogglePanel{})
	if a.PanelOpen() == open {
		t.Fatal("TogglePanel changed nothing")
	}
	a.Run(CmdTogglePanel)
	if a.PanelOpen() != open {
		t.Fatal("toggle command did not restore the state")
	}
}

func TestRunUnknownCommandShowsFailure(t *testing.T) {
	a := New()
	defer a.Shutdown()
	a.Run(commands.ID("does.not.exist"))
	if a.Notice().Key != "noticeCommandFailed" {
		t.Fatalf("notice = %q", a.Notice().Key)
	}
}

func TestCloseWorkspaceClearsEverything(t *testing.T) {
	a, _ := newTestApp(t)
	a.Dispatch(OpenFile{Path: "main.go"})
	a.Dispatch(CloseWorkspace{})
	if a.WorkspaceName() != "" || len(a.Tabs()) != 0 || len(a.Files()) != 0 {
		t.Fatalf("workspace=%q tabs=%d files=%d", a.WorkspaceName(), len(a.Tabs()), len(a.Files()))
	}
	// A second close is harmless.
	a.Dispatch(CloseWorkspace{})
}

func TestShutdownIsIdempotent(t *testing.T) {
	a := New()
	a.Shutdown()
	a.Shutdown()
	if !errors.Is(a.Ctx().Err(), context.Canceled) {
		t.Fatalf("ctx err = %v", a.Ctx().Err())
	}
	a.Dispatch(OpenFile{Path: "x"})
	if len(a.Tabs()) != 0 {
		t.Error("Dispatch after shutdown changed state")
	}
}

func TestNoteFrameIsInertWithoutBenchMode(t *testing.T) {
	a := New()
	defer a.Shutdown()
	a.bench = false
	a.NoteFrame()
	if a.firstFrame != 0 {
		t.Fatalf("firstFrame = %v, want 0", a.firstFrame)
	}
}

func TestBrowserURLAlwaysGetsAScheme(t *testing.T) {
	for raw, want := range map[string]string{
		"example.com":           "https://example.com",
		"https://example.com/a": "https://example.com/a",
		"  localhost:3000  ":    "https://localhost:3000",
	} {
		got, ok := browserURL(raw)
		if !ok || got != want {
			t.Errorf("browserURL(%q) = %q, %v; want %q", raw, got, ok, want)
		}
	}
	if _, ok := browserURL("   "); ok {
		t.Error("an empty address was accepted")
	}
}

func TestSidebarIntents(t *testing.T) {
	a, _ := newTestApp(t)
	a.Dispatch(ToggleLeft{})
	if a.LeftOpen() {
		t.Fatal("the sessions panel did not close")
	}
	a.Dispatch(ToggleRight{})
	if a.RightOpen() {
		t.Fatal("the right sidebar did not close")
	}
	a.Dispatch(ShowPanel{Name: "git"})
	if !a.RightOpen() || a.Layout.RightSel != "git" {
		t.Fatalf("ShowPanel = open %v, page %q", a.RightOpen(), a.Layout.RightSel)
	}
}
