// Package i18n holds the app's message catalogs and the lookup the views use.
//
// Messages live in locales/*.json in ICU MessageFormat (the same format MyGo's
// own controls use) and are embedded, so a packaged app carries no extra files.
// The source language is English; every other catalog falls back to it key by
// key, so a partially translated app still reads correctly.
//
// The language comes from the window: ui.Context.Locale(), which follows the
// system language unless mygo.json or the user sets another.
package i18n

import (
	"embed"
	"io/fs"
	"log/slog"

	mygoi18n "github.com/egoist/mygo/i18n"
)

// Source is the language the messages are written in first.
const Source = "en"

//go:embed locales/*.json
var files embed.FS

var catalog = mustCatalog()

func mustCatalog() *mygoi18n.Catalog {
	// NewCatalog reads "<tag>.json" at the root of the FS, so drop the
	// locales/ prefix the embed directive adds.
	dir, err := fs.Sub(files, "locales")
	if err != nil {
		slog.Error("i18n: locales directory missing", "err", err)
		return nil
	}
	c, err := mygoi18n.NewCatalog(dir, Source)
	if err != nil {
		// A broken catalog is a development mistake, but the app must still
		// start: T then returns message keys, which keeps the UI usable and
		// makes the missing text obvious.
		slog.Error("i18n: catalog unavailable", "err", err)
		return nil
	}
	return c
}

// Locale is the language MyGo says the app shows, for text built outside a view
// such as a menu item or a native dialog title.
func Locale() string { return mygoi18n.Locale() }

// T returns the message of key in locale. Results without arguments are cached
// by the catalog, so calling it every frame allocates nothing.
//
// A missing key or a missing catalog returns the key itself: a gap shows up in
// the UI instead of an empty label.
func T(locale, key string) string {
	if catalog == nil || key == "" {
		return key
	}
	return catalog.Format(locale, key, nil)
}

// Tf is T with arguments for the message's placeholders. Use it for the few
// messages that carry data, such as a file path.
func Tf(locale, key string, args map[string]any) string {
	if catalog == nil {
		return key
	}
	if len(args) == 0 {
		return catalog.Format(locale, key, nil)
	}
	return catalog.Format(locale, key, args)
}
