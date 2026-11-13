package l10n

import "github.com/egoist/mygo/i18n"

// AppText says the message of key in the language the app shows, for what is said away from a
// window, such as a dialog opened from a goroutine.
func AppText(key string) string { return catalog.Format(i18n.Locale(), key, nil) }
