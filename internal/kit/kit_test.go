package kit

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

// TestNewFollowsTheWindowAppearance checks the Theme the window is drawn with:
// the same tokens the widgets get, and a palette that follows the appearance.
func TestNewFollowsTheWindowAppearance(t *testing.T) {
	var got Theme
	var widgetBG ui.Color
	for _, dark := range []bool{true, false} {
		tt := ui.NewTester(func(c *ui.Context) {
			got = New(c)
			widgetBG = c.Theme().Background
			ui.Text(c, "x")
		}, 200, 100)
		tt.SetDark(dark)
		tt.Frame()
		if got.Dark != dark {
			t.Errorf("SetDark(%v) drew Dark = %v", dark, got.Dark)
		}
		if widgetBG != got.BG {
			t.Errorf("widgets get background %v, tokens say %v", widgetBG, got.BG)
		}
		if got.FontUI == 0 || got.RowH == 0 || got.LeftW == 0 {
			t.Errorf("tokens are not set: %+v", got)
		}
	}
}

// TestIconTabsClicksTheTab checks the sidebar's strip: each icon is a labelled
// target, and the active one is the page shown.
func TestIconTabsClicksTheTab(t *testing.T) {
	clicked := ""
	tt := ui.NewTester(func(c *ui.Context) {
		st := New(c)
		st.IconTabs(c, []IconTab{
			{Icon: IconFiles, Label: "Files", Active: true, OnClick: func() { clicked = "files" }},
			{Icon: IconGit, Label: "Changes", OnClick: func() { clicked = "changes" }},
		})
	}, 240, 60)
	tt.Frame()
	if err := tt.Click("Changes"); err != nil {
		t.Fatalf("click changes: %v", err)
	}
	tt.Frame()
	if clicked != "changes" {
		t.Fatalf("clicked %q", clicked)
	}
}

// TestRowClicksAndMarksActive checks the list row every panel's list is made of.
func TestRowClicksAndMarksActive(t *testing.T) {
	clicked := ""
	tt := ui.NewTester(func(c *ui.Context) {
		st := New(c)
		st.Row(c, RowSpec{
			Icon:    IconFileCode,
			Label:   "shell.go",
			Meta:    "M",
			MetaClr: st.Warning,
			Active:  true,
			OnClick: func() { clicked = "shell.go" },
		})
	}, 240, 60)
	tt.Frame()
	if !tt.HasText("shell.go") || !tt.HasText("M") {
		t.Fatalf("row text missing; texts = %v", tt.Texts())
	}
	if err := tt.Click("shell.go"); err != nil {
		t.Fatalf("click row: %v", err)
	}
	if clicked != "shell.go" {
		t.Fatalf("clicked %q", clicked)
	}
}

func TestIconsParse(t *testing.T) {
	for name, icon := range map[string]*ui.SVG{
		"files": IconFiles, "search": IconSearch, "git": IconGit, "terminal": IconTerminal,
		"sidebar": IconSidebarRight, "run": IconRun, "globe": IconGlobe,
	} {
		if icon == nil {
			t.Errorf("icon %q did not parse", name)
		}
	}
}

func TestFileIconByExtension(t *testing.T) {
	st := Theme{Dark: true, Muted: ui.Hex("#8c8c99"), Faint: ui.Hex("#666672")}
	for name, want := range map[string]*ui.SVG{
		"main.go":    IconFileCode,
		"go.mod":     IconFileCode,
		"README.md":  IconFileText,
		"mygo.json":  IconFileJSON,
		"install.sh": IconTerminal,
		"unknown.xx": IconFile,
	} {
		got, _ := st.FileIcon(name)
		if got != want {
			t.Errorf("FileIcon(%q) = %v, want %v", name, got, want)
		}
	}
}
