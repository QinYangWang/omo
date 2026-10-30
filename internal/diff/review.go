// Package diff builds the two sides of a change review.
//
// A review compares the text a file had (git's HEAD version, or the saved
// version when there is no repository) with the text it has now. Accepting the
// review writes the new side back; the editor's DiffState reports which hunks
// the user kept, so a rejection is just the new text with those hunks reverted.
package diff

import (
	"context"

	"github.com/QinYangWang/omo/internal/git"
	"github.com/QinYangWang/omo/internal/workspace"
)

// Review is one file's change.
type Review struct {
	Rel string
	// Old is the baseline text: HEAD's version, empty for a file git does not
	// have.
	Old string
	// New is the current text, either from disk or from an editor buffer.
	New string
	// NewFile reports that the baseline had no text at all.
	NewFile bool
	// Stamp is the disk version New came from, so saving can refuse to
	// overwrite a write that landed in between.
	Stamp workspace.FileStamp
}

// FromGit reviews a workspace file against its HEAD version.
func FromGit(ctx context.Context, repo *git.Repo, ws *workspace.Service, rel string) (Review, error) {
	data, stamp, err := ws.Read(rel)
	if err != nil {
		return Review{}, err
	}
	old, inHead, err := repo.HeadText(ctx, rel)
	if err != nil {
		return Review{}, err
	}
	return Review{Rel: rel, Old: old, New: string(data), NewFile: !inHead, Stamp: stamp}, nil
}

// FromBuffer reviews a buffer's unsaved text against the text on disk.
func FromBuffer(rel, saved, current string, stamp workspace.FileStamp) Review {
	return Review{Rel: rel, Old: saved, New: current, Stamp: stamp}
}

// Changed reports whether the two sides differ.
func (r Review) Changed() bool { return r.Old != r.New }

// Save writes the reviewed text back to disk, refusing when the file changed
// since the review was built.
func Save(ws *workspace.Service, r Review) (workspace.FileStamp, error) {
	return ws.Write(r.Rel, []byte(r.New), r.Stamp)
}
