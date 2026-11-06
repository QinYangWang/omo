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
		if got.FontUI == 0 || got.RowH == 0 || got.SideW == 0 {
			t.Errorf("tokens are not set: %+v", got)
		}
	}
}

// TestModeOverridesTheSystem checks Settings → Appearance: a chosen mode wins
// over the window's appearance, and the accent is the system's one blue.
func TestModeOverridesTheSystem(t *testing.T) {
	var got Theme
	for _, tc := range []struct {
		mode   Mode
		system bool
		dark   bool
		accent ui.Color
	}{
		{ModeDark, false, true, ui.Hex("#7C93FF")},
		{ModeLight, true, false, ui.Hex("#3654D6")},
		{ModeSystem, true, true, ui.Hex("#7C93FF")},
	} {
		tt := ui.NewTester(func(c *ui.Context) {
			got = NewFor(c, tc.mode)
			ui.Text(c, "x")
		}, 200, 100)
		tt.SetDark(tc.system)
		tt.Frame()
		if got.Dark != tc.dark || got.Accent != tc.accent {
			t.Errorf("mode %s on system dark=%v: dark=%v accent=%v", tc.mode, tc.system, got.Dark, got.Accent)
		}
	}
}

// TestRowClicksAndMarksActive checks the list row every list is made of.
func TestRowClicksAndMarksActive(t *testing.T) {
	clicked := ""
	tt := ui.NewTester(func(c *ui.Context) {
		st := New(c)
		st.Row(c, RowSpec{
			Icon:    IconFileCode,
			Label:   "shell.go",
			Badge:   "M",
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

// TestControlsChangeTheirState checks that the switch, the segmented control and
// the select box are real controls, not pictures of them.
func TestControlsChangeTheirState(t *testing.T) {
	on, seg, sel := false, 0, 0
	tt := ui.NewTester(func(c *ui.Context) {
		st := New(c)
		ui.Column(c).Children(func() {
			st.Switch(c, &on, "Collapse")
			st.Seg(c, &seg, "Ask", "Auto")
			st.SelectBox(c, "Model", &sel, []string{"A", "B"})
		})
	}, 300, 200)
	tt.Frame()
	for _, label := range []string{"Collapse", "Auto", "Model"} {
		if err := tt.Click(label); err != nil {
			t.Fatalf("click %s: %v", label, err)
		}
		tt.Frame()
	}
	if !on || seg != 1 || sel != 1 {
		t.Fatalf("on=%v seg=%d sel=%d", on, seg, sel)
	}
}

// TestButtonClicks checks a text button with a key cap.
func TestButtonClicks(t *testing.T) {
	clicked := false
	tt := ui.NewTester(func(c *ui.Context) {
		st := New(c)
		st.Btn(c, Button{Label: "Allow once", Kind: ButtonPrimary, Key: "Enter"}, func() { clicked = true })
	}, 300, 60)
	tt.Frame()
	if err := tt.Click("Allow once"); err != nil {
		t.Fatal(err)
	}
	if !clicked {
		t.Fatal("button did not click")
	}
}

func TestIconsParse(t *testing.T) {
	for name, icon := range map[string]*ui.SVG{
		"files": IconFiles, "search": IconSearch, "git": IconGit, "terminal": IconTerminal,
		"new": IconNewSession, "schedule": IconSchedule, "plan": IconPlan, "diff": IconFileDiff,
		"shield": IconShieldAlert, "pi": IconPi, "sun": IconSun, "moon": IconMoon, "logo": IconLogo,
	} {
		if icon == nil {
			t.Errorf("icon %q did not parse", name)
		}
	}
}

func TestFileIconByExtension(t *testing.T) {
	st := Theme{Dark: true}
	for name, want := range map[string]*ui.SVG{
		"main.go":    IconFileCode,
		"go.mod":     IconFileCode,
		"README.md":  IconFileText,
		"mygo.json":  IconFileJSON,
		"unknown.xx": IconFile,
	} {
		got, _ := st.FileIcon(name)
		if got != want {
			t.Errorf("FileIcon(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestRegisterFonts(t *testing.T) {
	if err := RegisterFonts(); err != nil {
		t.Fatal(err)
	}
}
