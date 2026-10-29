package app

import (
	"errors"

	"github.com/QinYangWang/omo/internal/diff"
	"github.com/QinYangWang/omo/internal/workspace"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/editor"
)

// Intent is a state change the views may ask for. Views never write App fields
// and never do IO themselves: they call Dispatch, which decides what changes.
//
// The selected tab, panel page and terminal have no intents: UI widgets bind to
// the Layout fields directly, as immediate-mode UI does.
type Intent interface{ isIntent() }

// OpenFile opens a workspace-relative file in the editor.
type OpenFile struct{ Path string }

// CloseTab closes an open tab.
type CloseTab struct{ Index int }

// SaveFile saves the active file tab.
type SaveFile struct{}

// OpenDiff opens a review of one file against its HEAD version.
type OpenDiff struct{ Path string }

// ApplyReview writes the reviewed text of the active diff tab to disk.
type ApplyReview struct{}

// ResolveConflict answers a disk-change conflict.
type ResolveConflict struct{ Choice ConflictChoice }

// ConflictChoice is how the user resolved a file that changed on disk.
type ConflictChoice int

const (
	// ConflictOverwrite replaces the file with the buffer.
	ConflictOverwrite ConflictChoice = iota
	// ConflictReload replaces the buffer with the file.
	ConflictReload
	// ConflictCancel keeps both as they are and closes the dialog.
	ConflictCancel
)

// TogglePanel shows or hides the bottom panel.
type TogglePanel struct{}

// ToggleChat shows or hides the chat panel.
type ToggleChat struct{}

// NewTerminal starts a shell in the bottom panel.
type NewTerminal struct{}

// CloseTerminal kills one terminal session.
type CloseTerminal struct{ Index int }

// RefreshChanges re-reads git status.
type RefreshChanges struct{}

// OpenWorkspace opens a workspace directory.
type OpenWorkspace struct{ Path string }

// CloseWorkspace closes the current workspace.
type CloseWorkspace struct{}

func (OpenFile) isIntent()        {}
func (CloseTab) isIntent()        {}
func (SaveFile) isIntent()        {}
func (OpenDiff) isIntent()        {}
func (ApplyReview) isIntent()     {}
func (ResolveConflict) isIntent() {}
func (TogglePanel) isIntent()     {}
func (ToggleChat) isIntent()      {}
func (NewTerminal) isIntent()     {}
func (CloseTerminal) isIntent()   {}
func (RefreshChanges) isIntent()  {}
func (OpenWorkspace) isIntent()   {}
func (CloseWorkspace) isIntent()  {}

// Dispatch applies an intent on the main thread. View callbacks call it
// directly.
func (a *App) Dispatch(in Intent) {
	if a.closed.Load() {
		return
	}
	switch v := in.(type) {
	case OpenFile:
		a.openFile(v.Path)
	case CloseTab:
		a.closeTab(v.Index)
	case SaveFile:
		a.saveActive()
	case OpenDiff:
		a.openDiff(v.Path)
	case ApplyReview:
		a.applyReview()
	case ResolveConflict:
		a.resolveConflict(v.Choice)
	case TogglePanel:
		a.panelOpen = !a.panelOpen
	case ToggleChat:
		a.chatOpen = !a.chatOpen
	case NewTerminal:
		a.newTerminal()
	case CloseTerminal:
		a.closeTerminal(v.Index)
	case RefreshChanges:
		a.refreshGit(true)
	case OpenWorkspace:
		a.openWorkspace(v.Path)
	case CloseWorkspace:
		a.closeWorkspace()
	}
	a.invalidate()
}

func (a *App) closeTab(i int) {
	if i < 0 || i >= len(a.tabs) {
		return
	}
	a.tabs = append(a.tabs[:i], a.tabs[i+1:]...)
	switch {
	case len(a.tabs) == 0:
		a.Layout.ActiveTab = 0
	case a.Layout.ActiveTab >= len(a.tabs):
		a.Layout.ActiveTab = len(a.tabs) - 1
	case a.Layout.ActiveTab > i:
		a.Layout.ActiveTab--
	}
}

func (a *App) openFile(rel string) {
	if a.docs == nil {
		a.setNotice(Notice{Key: "noticeNeedWorkspace"})
		return
	}
	doc, _, err := a.docs.Open(rel)
	if err != nil {
		a.fileErrorNotice(rel, err)
		return
	}
	for i := range a.tabs {
		if a.tabs[i].Kind == TabFile && a.tabs[i].Rel == rel {
			a.Layout.ActiveTab = i
			return
		}
	}
	a.tabs = append(a.tabs, Tab{
		Kind: TabFile,
		Rel:  rel,
		// 13 DIP is the size code reads well at; the editor's own default is
		// larger, as it is sized for prose.
		Editor:   &editor.State{Buffer: doc.Buf, Label: rel, Font: ui.Font{Size: 13}, LineHeight: 1.5},
		Saveable: true,
	})
	a.Layout.ActiveTab = len(a.tabs) - 1
}

func (a *App) fileErrorNotice(rel string, err error) {
	switch {
	case errors.Is(err, workspace.ErrTooLarge):
		a.setNotice(Notice{Key: "noticeFileTooLarge", Args: map[string]any{"path": rel}})
	case errors.Is(err, workspace.ErrNotRegular):
		a.setNotice(Notice{Key: "noticeFileFailed", Args: map[string]any{"path": rel, "err": err.Error()}})
	default:
		a.setNotice(Notice{Key: "noticeFileFailed", Args: map[string]any{"path": rel, "err": err.Error()}})
	}
}

// activeTab returns the tab under the cursor, or nil.
func (a *App) activeTab() *Tab {
	if i := a.ActiveTab(); i >= 0 {
		return &a.tabs[i]
	}
	return nil
}

func (a *App) saveActive() {
	t := a.activeTab()
	if t == nil || t.Kind != TabFile || a.docs == nil {
		return
	}
	if err := a.docs.Save(t.Rel); err != nil {
		if errors.Is(err, workspace.ErrConflict) {
			a.conflict = t.Rel
			a.conflictOpen = true
			return
		}
		a.setNotice(Notice{Key: "noticeSaveFailed", Args: map[string]any{"err": err.Error()}})
		return
	}
	a.setNotice(Notice{Key: "noticeFileSaved", Args: map[string]any{"path": t.Rel}})
	a.refreshGit(true)
}

// openDiff shows a review of rel: against HEAD in a repository, else against
// the saved version when the buffer has unsaved text.
func (a *App) openDiff(rel string) {
	if a.ws == nil {
		a.setNotice(Notice{Key: "noticeNeedWorkspace"})
		return
	}
	for i := range a.tabs {
		if a.tabs[i].Kind == TabDiff && a.tabs[i].Rel == rel {
			a.Layout.ActiveTab = i
			return
		}
	}
	review, err := a.buildReview(rel)
	if err != nil {
		a.setNotice(Notice{Key: "noticeFileFailed", Args: map[string]any{"path": rel, "err": err.Error()}})
		return
	}
	if !review.Changed() {
		a.setNotice(Notice{Key: "noticeNoChanges", Args: map[string]any{"path": rel}})
		return
	}
	st := &editor.DiffState{
		Old:           editor.NewBuffer(review.Old),
		New:           editor.NewBuffer(review.New),
		Layout:        editor.DiffSplit,
		Indicators:    editor.DiffBars,
		Inline:        editor.DiffInlineWord,
		HunkActions:   true,
		ContextLines:  3,
		FitContent:    false,
		NoLineNumbers: false,
	}
	a.tabs = append(a.tabs, Tab{Kind: TabDiff, Rel: rel, Diff: st, Review: review})
	a.Layout.ActiveTab = len(a.tabs) - 1
}

func (a *App) buildReview(rel string) (diff.Review, error) {
	if a.repo != nil {
		return diff.FromGit(a.ctx, a.repo, a.ws, rel)
	}
	data, stamp, err := a.ws.Read(rel)
	if err != nil {
		return diff.Review{}, err
	}
	current := string(data)
	if a.docs != nil {
		if doc, ok := a.docs.Get(rel); ok {
			current = doc.Buf.String()
		}
	}
	return diff.FromBuffer(rel, string(data), current, stamp), nil
}

// applyReview writes the reviewed text back and makes the document agree with
// it, so the editor does not immediately show a conflict.
func (a *App) applyReview() {
	t := a.activeTab()
	if t == nil || t.Kind != TabDiff || a.ws == nil {
		return
	}
	t.Review.New = t.Diff.New.String()
	if _, err := diff.Save(a.ws, t.Review); err != nil {
		if errors.Is(err, workspace.ErrConflict) {
			a.conflict = t.Rel
			a.conflictOpen = true
			return
		}
		a.setNotice(Notice{Key: "noticeSaveFailed", Args: map[string]any{"err": err.Error()}})
		return
	}
	if a.docs != nil {
		if _, ok := a.docs.Get(t.Rel); ok {
			if _, err := a.docs.Reload(t.Rel); err != nil {
				a.docs.Adopt(t.Rel)
			}
			a.syncEditorBeforeReload(t.Rel)
		}
	}
	a.setNotice(Notice{Key: "noticeReviewSaved", Args: map[string]any{"path": t.Rel}})
	t.Saveable = false
	a.refreshGit(true)
}

func (a *App) resolveConflict(choice ConflictChoice) {
	rel := a.conflict
	a.conflictOpen = false
	a.conflict = ""
	if rel == "" {
		return
	}
	switch choice {
	case ConflictOverwrite:
		if a.docs == nil {
			return
		}
		if err := a.docs.ForceSave(rel); err != nil {
			a.setNotice(Notice{Key: "noticeSaveFailed", Args: map[string]any{"err": err.Error()}})
			return
		}
		a.setNotice(Notice{Key: "noticeFileSaved", Args: map[string]any{"path": rel}})
		a.refreshGit(true)
	case ConflictReload:
		if a.docs == nil {
			return
		}
		if _, err := a.docs.Reload(rel); err != nil {
			a.setNotice(Notice{Key: "noticeFileFailed", Args: map[string]any{"path": rel, "err": err.Error()}})
			return
		}
		a.setNotice(Notice{Key: "noticeReloaded", Args: map[string]any{"path": rel}})
	case ConflictCancel:
	}
}

// ChangesCount is the number of paths that differ from HEAD.
func (a *App) ChangesCount() int { return len(a.changes) }

// changeStatus returns the git status letter of a path, or "".
func (a *App) changeStatus(rel string) string {
	for _, c := range a.changes {
		if c.Path == rel {
			return c.Status
		}
	}
	return ""
}
