package app

import (
	"testing"

	"github.com/egoist/mygo"

	"github.com/QinYangWang/omo/internal/config"
)

func TestThemeSource(t *testing.T) {
	cases := map[string]mygo.ThemeSource{
		"":        mygo.ThemeSystem,
		"system":  mygo.ThemeSystem,
		"Light":   mygo.ThemeLight,
		"dark":    mygo.ThemeDark,
		"unknown": mygo.ThemeSystem,
	}
	for value, want := range cases {
		if got := ThemeSource(value); got != want {
			t.Errorf("ThemeSource(%q) = %q, want %q", value, got, want)
		}
	}
	if got := WindowBackdrop(config.AppearanceLight); got != "#f8f8f8" {
		t.Errorf("light backdrop %q", got)
	}
}
