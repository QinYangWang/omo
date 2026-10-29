package app

import (
	"path"

	"github.com/egoist/mygo/ui/editor"
)

// editorState and editorDiff keep the framework's editor types out of the rest
// of the app: everything that touches them stays in this package and the view.
type (
	editorState = editor.State
	editorDiff  = editor.DiffState
)

// baseName is the last element of a workspace-relative path, used as a tab title.
func baseName(rel string) string { return path.Base(rel) }

// dirName is the directory part of a workspace-relative path, "." for the root.
func dirName(rel string) string {
	d := path.Dir(rel)
	if d == "" {
		return "."
	}
	return d
}
