// Package l10n holds the texts Lobe MyGo's components say themselves, in English and the
// languages they are translated to: a library catalog of the namespace "lobe", said in the
// language of the window. An app changes them, or translates them to its other languages, with
// keys "lobe.<key>" in its own catalogs.
package l10n

import (
	"embed"
	"io/fs"

	"github.com/egoist/mygo/i18n"
	"github.com/egoist/mygo/ui"
)

const Namespace = "lobe"

//go:embed messages/*.json
var messages embed.FS

var catalog = func() *i18n.Catalog {
	files, err := fs.Sub(messages, "messages")
	if err != nil {
		panic(err)
	}
	c, err := i18n.NewLibraryCatalog(files, "en", Namespace)
	if err != nil {
		panic(err)
	}
	return c
}()

// Text says the message of key in the language of c's window.
func Text(c *ui.Context, key string) string { return catalog.Format(c.Locale(), key, nil) }

// Format says the message of key with args in the language of c's window.
func Format(c *ui.Context, key string, args map[string]any) string {
	return catalog.Format(c.Locale(), key, args)
}
