package view

import (
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/QinYangWang/omo/internal/app"
	"github.com/egoist/mygo/ui"
)

// The screenshots in docs/ui are generated, not taken by hand: the same window
// states, the same demo workspace, on any machine. Run
//
//	OMO_SCREENSHOTS=1 go test ./internal/view -run TestWriteScreenshots
//
// to rewrite them; the test does nothing without the variable, so `go test ./...`
// never writes to the repository.
func TestWriteScreenshots(t *testing.T) {
	if os.Getenv("OMO_SCREENSHOTS") == "" {
		t.Skip("set OMO_SCREENSHOTS=1 to rewrite docs/ui")
	}
	out, err := filepath.Abs(filepath.Join("..", "..", "docs", "ui"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	fixture := shotFixture(t)

	shoot := func(name string, dark bool, prepare func(a *app.App)) {
		t.Helper()
		a := app.New()
		if prepare != nil {
			prepare(a)
		}
		t.Cleanup(a.Shutdown)
		tt := ui.NewTester(func(c *ui.Context) { Shell(c, a) }, 1440, 900)
		tt.SetDark(dark)
		tt.Frame()
		f, err := os.Create(filepath.Join(out, name))
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if err := png.Encode(f, tt.Image()); err != nil {
			t.Fatal(err)
		}
		t.Log(name)
	}
	workspace := func(a *app.App) { a.Dispatch(app.OpenWorkspace{Path: fixture}) }
	with := func(extra ...func(*app.App)) func(*app.App) {
		return func(a *app.App) {
			workspace(a)
			for _, fn := range extra {
				fn(a)
			}
		}
	}
	openShell := func(a *app.App) { a.Dispatch(app.OpenFile{Path: "internal/view/shell.go"}) }
	openPage := func(id string) func(*app.App) {
		return func(a *app.App) { a.Dispatch(app.ShowPanel{Name: id}) }
	}

	shoot("01-welcome-dark.png", true, nil)
	shoot("02-welcome-light.png", false, nil)
	shoot("03-session-dark.png", true, workspace)
	shoot("04-files-dark.png", true, with(openShell))
	shoot("05-changes-light.png", false, with(openPage("git")))
	shoot("06-diff-dark.png", true, with(func(a *app.App) { a.Dispatch(app.OpenDiff{Path: "main.go"}) }))
	shoot("07-search-dark.png", true, with(openPage("search")))
	shoot("08-run-dark.png", true, with(openPage("run")))
	shoot("09-browser-dark.png", true, with(openPage("browser")))
	shoot("10-panel-dark.png", true, with(func(a *app.App) { a.Dispatch(app.TogglePanel{}) }))
	shoot("11-collapsed-dark.png", true, with(openShell, func(a *app.App) {
		a.Dispatch(app.ToggleLeft{})
		a.Dispatch(app.ToggleRight{})
	}))
}

// shotFixture builds the demo workspace every screenshot is taken from: the same
// files and the same two changes against HEAD, on any machine. Without git the
// workspace still builds; only the change-dependent views are empty.
func shotFixture(t *testing.T) string {
	t.Helper()
	// A named child of the temp dir, so the window shows "demo" and not a
	// random temp name.
	dir := filepath.Join(t.TempDir(), "demo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"go.mod":                 "module demo\n\ngo 1.27.3\n",
		"main.go":                "package main\n\nimport \"github.com/egoist/mygo\"\n\nfunc main() {\n\tmygo.App.Run()\n}\n",
		"README.md":              "# demo\n\nA project for the screenshots.\n",
		"docs/notes.md":          "# notes\n\n- keep the window light\n",
		"internal/app/app.go":    "package app\n\n// App owns the window state.\ntype App struct {\n\tWidth int\n}\n",
		"internal/view/shell.go": "package view\n\n// Shell draws the window.\nfunc Shell() {}\n",
		"internal/kit/theme.go":  "package kit\n\n// Theme holds the design tokens.\ntype Theme struct{}\n",
	}
	for name, body := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := exec.LookPath("git"); err == nil {
		for _, args := range [][]string{
			{"init", "--initial-branch=main", "."},
			{"add", "."},
			{"commit", "-m", "initial"},
		} {
			cmd := exec.Command("git", args...)
			cmd.Dir = dir
			cmd.Env = append(os.Environ(),
				"GIT_AUTHOR_NAME=demo", "GIT_AUTHOR_EMAIL=demo@example.com",
				"GIT_COMMITTER_NAME=demo", "GIT_COMMITTER_EMAIL=demo@example.com",
				"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
			if outp, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("git %v: %v: %s", args, err, outp)
			}
		}
		// Two changes against HEAD: one for the file tree, one for the diff.
		changed := map[string]string{
			"main.go":             "package main\n\nimport (\n\t\"fmt\"\n\n\t\"github.com/egoist/mygo\"\n)\n\nfunc main() {\n\tfmt.Println(\"demo\")\n\tmygo.App.Run()\n}\n",
			"internal/app/app.go": "package app\n\n// App owns the window state and the open workspace.\ntype App struct {\n\tWidth  int\n\tHeight int\n}\n",
		}
		for name, body := range changed {
			if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(name)), []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	return dir
}
