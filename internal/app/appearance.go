package app

import (
	"github.com/egoist/mygo"

	"github.com/QinYangWang/omo/internal/config"
)

// ThemeSource maps the appearance setting onto MyGo's override.
func ThemeSource(value string) mygo.ThemeSource {
	switch config.NormalizeAppearance(value) {
	case config.AppearanceLight:
		return mygo.ThemeLight
	case config.AppearanceDark:
		return mygo.ThemeDark
	default:
		return mygo.ThemeSystem
	}
}

// WindowBackdrop is the color behind the content before it draws.
func WindowBackdrop(value string) string {
	if config.NormalizeAppearance(value) == config.AppearanceLight {
		return "#f8f8f8"
	}
	return "#000000"
}

// AppearanceIndex is the position of the setting in config.Appearances.
func AppearanceIndex(value string) int {
	value = config.NormalizeAppearance(value)
	for i, known := range config.Appearances {
		if value == known {
			return i
		}
	}
	return 0
}

// SetAppearance switches the whole window and remembers the choice.
func (a *App) SetAppearance(value string) {
	a.update(func() {
		value = config.NormalizeAppearance(value)
		a.Config.Settings.Appearance = value
		if err := a.Config.Save(); err != nil {
			a.Failure = err.Error()
			return
		}
		mygo.Theme.SetSource(ThemeSource(value))
	})
}
