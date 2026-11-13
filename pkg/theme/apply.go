package theme

import (
	"sync"

	"github.com/egoist/mygo/ui"
)

// Config is a light and a dark set of tokens that a window applies in place of
// Lobe UI's defaults, such as tokens generated from an app's own brand. Make it
// once with NewConfig and apply it at the top of each view; the components
// inside then draw with its tokens.
type Config struct {
	light, dark           Tokens
	lightTheme, darkTheme *ui.Theme
}

var (
	// configs maps each theme a Config made to the tokens it came from, so
	// TokensOf follows whichever theme the widgets being built take: the
	// window's, or that of a Themed around them.
	configs sync.Map // *ui.Theme -> *Tokens

	defaults = NewConfig(lightTokens, darkTokens)
)

// NewConfig makes a Config from a light and a dark set of tokens. Their Dark
// fields are set to match. Keep the Config for the life of the app rather than
// making one for each frame: every Config is remembered.
func NewConfig(light, dark Tokens) *Config {
	light.Dark, dark.Dark = false, true
	cfg := &Config{light: light, dark: dark}
	cfg.lightTheme, cfg.darkTheme = cfg.light.Theme(), cfg.dark.Theme()
	configs.Store(cfg.lightTheme, &cfg.light)
	configs.Store(cfg.darkTheme, &cfg.dark)
	return cfg
}

// Apply makes the frame use the Config's light or dark theme, following the
// system's appearance.
func (cfg *Config) Apply(c *ui.Context) {
	c.SetTheme(cfg.Theme(c.Theme().Dark))
}

// Theme returns the Config's dark or light theme, for a Themed subtree.
func (cfg *Config) Theme(dark bool) *ui.Theme {
	if dark {
		return cfg.darkTheme
	}
	return cfg.lightTheme
}

// Tokens returns a copy of the Config's dark or light tokens.
func (cfg *Config) Tokens(dark bool) *Tokens {
	t := cfg.light
	if dark {
		t = cfg.dark
	}
	return &t
}

// Default returns the Config of Lobe UI's own tokens, which Apply uses.
func Default() *Config { return defaults }

// Apply makes the frame use Lobe UI's light or dark theme, following the
// system's appearance.
func Apply(c *ui.Context) { defaults.Apply(c) }

// TokensOf returns a copy of the tokens of the theme the widgets being built
// take: those of the Config that made it, or Lobe UI's light or dark tokens
// for any other theme.
func TokensOf(c *ui.Context) *Tokens {
	th := c.Theme()
	if tk, ok := configs.Load(th); ok {
		t := *tk.(*Tokens)
		return &t
	}
	return defaults.Tokens(th.Dark)
}
