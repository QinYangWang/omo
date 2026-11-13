package nav

import (
	"testing"

	"github.com/egoist/mygo/ui"
	"github.com/QinYangWang/omo/pkg/internal/testkit"
	"github.com/QinYangWang/omo/pkg/theme"
)

func stepsTester(p StepsProps) *ui.Tester {
	p.Items = []StepItem{{Title: "Account"}, {Title: "Profile", Description: "Name and avatar"}, {Title: "Done"}}
	return ui.NewTester(func(c *ui.Context) {
		theme.Apply(c)
		ui.Column(c).Padding(20).Width(500).Children(func() { Steps(c, p) })
	}, 540, 200)
}

func TestStepsStatuses(t *testing.T) {
	tk := theme.Light()
	tt := stepsTester(StepsProps{Current: 1})
	if tt.HasText("1") || !tt.HasText("2") || !tt.HasText("3") {
		t.Errorf("texts %q: want a check for the finished first step and numbers after", tt.Texts())
	}
	profile, _ := tt.Find("Profile")
	desc, _ := tt.Find("Name and avatar")
	if got := testkit.PixelAt(tt, 540, profile.X-8-11-6, (profile.Y+desc.Y+desc.H)/2); !testkit.Near(got, tk.Primary) {
		t.Errorf("current step's indicator %+v, want filled Primary", got)
	}
	done, _ := tt.Find("Done")
	if got := testkit.PixelAt(tt, 540, done.X-8-11, done.Y+11-6); testkit.Near(got, tk.Primary) {
		t.Errorf("waiting step's indicator filled")
	}
	account, _ := tt.Find("Account")
	mid, line := (account.X+account.W+8+profile.X-8-22)/2, false
	for y := account.Y + 9; y <= account.Y+13; y++ {
		line = line || testkit.Near(testkit.PixelAt(tt, 540, mid, y), tk.Primary)
	}
	if !line {
		t.Error("connector after a finished step is not Primary")
	}
}

func TestStepsVertical(t *testing.T) {
	tt := stepsTester(StepsProps{Current: 2, Vertical: true})
	a, _ := tt.Find("Account")
	p, _ := tt.Find("Profile")
	d, _ := tt.Find("Name and avatar")
	if !(a.Y < p.Y && p.Y < d.Y) || p.X != a.X {
		t.Errorf("vertical: account %v profile %v desc %v", a, p, d)
	}
}

func TestVerticalNavLeavesNoStrayElement(t *testing.T) {
	sel := 0
	tt := ui.NewTester(func(c *ui.Context) {
		theme.Apply(c)
		ui.Row(c).Gap(16).Children(func() {
			Steps(c, StepsProps{Vertical: true, Items: []StepItem{{Title: "One"}}})
			Tabs(c, &sel, TabsProps{Vertical: true, Items: []TabItem{{Label: "Tab"}}}, nil)
			ui.Box(c).Size(10, 10).Label("End")
		})
	}, 400, 100)
	one, _ := tt.Find("One")
	tab := tabBox(t, tt, "Tab")
	end, _ := tt.Find("End")
	if gap := tab.X - 3 - (one.X + one.W); gap > 16.5 {
		t.Errorf("%v DIPs between the steps and the tabs, want one 16 DIP gap", gap)
	}
	if gap := end.X - (tab.X + tab.W + 3); gap > 16.5 {
		t.Errorf("%v DIPs between the tabs and the next element, want one 16 DIP gap", gap)
	}
}

func TestCurrentStepLabelTakesPrimaryForeground(t *testing.T) {
	light, dark := *theme.Light(), *theme.Dark()
	light.Primary, dark.Primary = ui.Hex("#0559ff"), ui.Hex("#1e61e6")
	light.PrimaryForeground, dark.PrimaryForeground = light.TextLightSolid, dark.TextLightSolid
	cfg := theme.NewConfig(light, dark)
	tt := ui.NewTester(func(c *ui.Context) {
		cfg.Apply(c)
		ui.Column(c).Padding(20).Width(500).Children(func() {
			Steps(c, StepsProps{Current: 1, Items: []StepItem{{Title: "Account"}, {Title: "Profile"}, {Title: "Done"}}})
		})
	}, 540, 200)
	for _, isDark := range []bool{false, true} {
		tt.SetDark(isDark)
		want := cfg.Tokens(isDark)
		r, ok := tt.Find("2")
		if !ok {
			t.Fatalf("no current step number; texts %q", tt.Texts())
		}
		if got := testkit.Ink(tt, 540, r, want.Primary); !testkit.Near(got, want.PrimaryForeground) {
			t.Errorf("dark=%v current step number = %+v, want PrimaryForeground %+v", isDark, got, want.PrimaryForeground)
		}
	}
}
