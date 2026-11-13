package theme

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func brand() *Config {
	light, dark := *Light(), *Dark()
	light.Primary, light.PrimaryHover, light.PrimaryActive = ui.Hex("#0559ff"), ui.Hex("#044ee0"), ui.Hex("#0343c2")
	dark.Primary, dark.PrimaryHover, dark.PrimaryActive = ui.Hex("#1e61e6"), ui.Hex("#1c5ad6"), ui.Hex("#174bb3")
	light.PrimaryForeground, dark.PrimaryForeground = light.TextLightSolid, dark.TextLightSolid
	return NewConfig(light, dark)
}

func TestDefaultTokensKeepLobeUIPrimaryForeground(t *testing.T) {
	for _, tk := range []*Tokens{Light(), Dark()} {
		if tk.PrimaryForeground != tk.BgLayout {
			t.Errorf("dark=%v PrimaryForeground = %+v, want BgLayout %+v", tk.Dark, tk.PrimaryForeground, tk.BgLayout)
		}
	}
}

func TestConfigTokensFollowAppearance(t *testing.T) {
	cfg := brand()
	var got *Tokens
	tt := ui.NewTester(func(c *ui.Context) {
		cfg.Apply(c)
		got = TokensOf(c)
	}, 100, 100)
	if got.Dark || got.Primary != ui.Hex("#0559ff") || got.PrimaryForeground != got.TextLightSolid {
		t.Errorf("light tokens = Dark %v Primary %+v PrimaryForeground %+v", got.Dark, got.Primary, got.PrimaryForeground)
	}
	tt.SetDark(true)
	if !got.Dark || got.Primary != ui.Hex("#1e61e6") {
		t.Errorf("dark tokens = Dark %v Primary %+v", got.Dark, got.Primary)
	}
}

func TestConfigSetsTheWindowTheme(t *testing.T) {
	cfg := brand()
	var accent, text ui.Color
	ui.NewTester(func(c *ui.Context) {
		cfg.Apply(c)
		accent, text = c.Theme().Accent, c.Theme().AccentText
	}, 100, 100)
	if accent != ui.Hex("#0559ff") || text != Light().TextLightSolid {
		t.Errorf("theme accent %+v on %+v, want brand primary under TextLightSolid", accent, text)
	}
}

func TestTokensOfFollowsAThemedSubtree(t *testing.T) {
	cfg := brand()
	var outside, inside *Tokens
	ui.NewTester(func(c *ui.Context) {
		Apply(c)
		outside = TokensOf(c)
		ui.Themed(c, cfg.Theme(true)).Children(func() { inside = TokensOf(c) })
	}, 100, 100)
	if outside.Primary != Light().Primary {
		t.Errorf("outside Primary = %+v, want Lobe UI's %+v", outside.Primary, Light().Primary)
	}
	if !inside.Dark || inside.Primary != ui.Hex("#1e61e6") {
		t.Errorf("inside = Dark %v Primary %+v, want the brand's dark tokens", inside.Dark, inside.Primary)
	}
}

func TestTokensOfAnotherThemeUsesLobeUIDefaults(t *testing.T) {
	var got *Tokens
	ui.NewTester(func(c *ui.Context) {
		c.SetTheme(ui.DarkTheme())
		got = TokensOf(c)
	}, 100, 100)
	if *got != *Dark() {
		t.Error("a theme no Config made should take Lobe UI's dark tokens")
	}
}

func TestConfigTokensAreCopies(t *testing.T) {
	cfg := brand()
	cfg.Tokens(false).Primary = ui.Hex("#ff0000")
	if cfg.Tokens(false).Primary != ui.Hex("#0559ff") {
		t.Error("changing returned tokens changed the Config")
	}
	if NewConfig(*Dark(), *Dark()).Tokens(false).Dark {
		t.Error("NewConfig should mark the light set as light")
	}
}
