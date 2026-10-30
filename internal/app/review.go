package app

import (
	"errors"
	"io/fs"

	"github.com/QinYangWang/omo/internal/diff"
	"github.com/QinYangWang/omo/internal/workspace"
	"github.com/egoist/mygo/ui/editor"
)

// AgentChange is one file whose text differs from what it had before the agent
// touched it in this workspace. The review is measured against that baseline,
// not against git HEAD, so it shows what the agent did even in a dirty tree.
type AgentChange struct {
	Rel     string
	Review  diff.Review
	Diff    *editorDiff
	Added   int
	Deleted int
}

// AgentChanges returns the files the agent changed, in the order it touched
// them.
func (a *App) AgentChanges() []AgentChange { return a.agentChanges }

// AgentChangeCount is how many files the agent changed.
func (a *App) AgentChangeCount() int { return len(a.agentChanges) }

// NoteAgentPaths records what the paths an ACP tool call reports hold now, before
// the agent writes them. The agent event loop calls it; it is exported so a
// screenshot or a test can build a review without starting an agent.
//
// ACP reports a tool call as it starts, so the read below usually beats the
// write; when it does not, the file simply shows no change instead of a wrong
// one.
func (a *App) NoteAgentPaths(paths ...string) {
	if a.ws == nil {
		return
	}
	if a.baseline == nil {
		a.baseline = diff.NewBaseline()
	}
	for _, rel := range paths {
		if !reviewable(rel) || a.baseline.Has(rel) {
			continue
		}
		data, _, err := a.ws.Read(rel)
		switch {
		case err == nil:
			a.baseline.Capture(rel, string(data), false)
		case errors.Is(err, fs.ErrNotExist):
			a.baseline.Capture(rel, "", true)
		default:
			// Too large or not a regular file: the review leaves it out.
		}
	}
	if a.baseline.Degraded() && !a.reviewWarned {
		a.reviewWarned = true
		a.setNotice(Notice{Key: "noticeReviewTooLarge"})
	}
}

// reviewable keeps elisions and paths outside the workspace out of the review.
// The agent protocol layer already maps those to "<external>".
func reviewable(rel string) bool {
	switch rel {
	case "", "…", "<external>":
		return false
	}
	return true
}

// refreshReview recomputes the agent changes from disk. It keeps a change's
// diff state while its text is unchanged, so per-hunk decisions survive a
// refresh triggered by an unrelated file.
func (a *App) refreshReview() {
	if a.ws == nil || a.baseline == nil {
		a.agentChanges = nil
		return
	}
	changes := make([]AgentChange, 0, len(a.baseline.Entries()))
	for _, base := range a.baseline.Entries() {
		data, stamp, err := a.ws.Read(base.Rel)
		exists := err == nil
		if !exists && !errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if base.NewFile && !exists {
			continue // still not there: the agent did not create it after all
		}
		now := string(data)
		if exists && !base.NewFile && now == base.Text {
			continue
		}
		if prev := a.changeFor(base.Rel); prev != nil && prev.Review.New == now && prev.Review.Stamp.Equal(stamp) {
			changes = append(changes, *prev)
			continue
		}
		st := &editor.DiffState{
			Old:          editor.NewBuffer(base.Text),
			New:          editor.NewBuffer(now),
			Layout:       editor.DiffSplit,
			Indicators:   editor.DiffBars,
			Inline:       editor.DiffInlineWord,
			HunkActions:  true,
			ContextLines: 3,
		}
		added, deleted := st.Stats()
		changes = append(changes, AgentChange{
			Rel:     base.Rel,
			Review:  diff.Review{Rel: base.Rel, Old: base.Text, New: now, NewFile: base.NewFile, Stamp: stamp},
			Diff:    st,
			Added:   added,
			Deleted: deleted,
		})
	}
	a.agentChanges = changes
}

// changeFor returns the agent change of rel, or nil.
func (a *App) changeFor(rel string) *AgentChange {
	for i := range a.agentChanges {
		if a.agentChanges[i].Rel == rel {
			return &a.agentChanges[i]
		}
	}
	return nil
}

// resetReview forgets the baselines and the changes they produced.
func (a *App) resetReview() {
	a.baseline = diff.NewBaseline()
	a.agentChanges = nil
	a.reviewWarned = false
}

// openReview shows the list of files the agent changed.
func (a *App) openReview() {
	if a.ws == nil {
		a.setNotice(Notice{Key: "noticeNeedWorkspace"})
		return
	}
	a.refreshReview()
	if len(a.agentChanges) == 0 {
		a.setNotice(Notice{Key: "noticeReviewEmpty"})
		return
	}
	for i := range a.tabs {
		if a.tabs[i].Kind == TabReview {
			a.Layout.ActiveTab = i
			return
		}
	}
	a.tabs = append(a.tabs, Tab{Kind: TabReview})
	a.Layout.ActiveTab = len(a.tabs) - 1
}

// acceptReview keeps what the agent wrote and starts a new baseline: the next
// change the agent makes is reviewed from here.
func (a *App) acceptReview() {
	count := len(a.agentChanges)
	if count == 0 {
		return
	}
	a.resetReview()
	a.setNotice(Notice{Key: "noticeReviewAccepted", Args: map[string]any{"count": count}})
}

// rejectReview puts every reviewed file back the way it was before the agent
// touched it, deleting the files the agent created.
func (a *App) rejectReview() {
	if a.ws == nil || len(a.agentChanges) == 0 {
		return
	}
	restored := 0
	for _, ch := range a.agentChanges {
		if ch.Review.NewFile {
			// shortcut: the baseline cannot tell "created then edited" from
			// "created", so a rejected new file is removed, not emptied.
			if err := a.ws.Remove(ch.Rel); err != nil && !errors.Is(err, fs.ErrNotExist) {
				a.setNotice(Notice{Key: "noticeSaveFailed", Args: map[string]any{"err": err.Error()}})
				return
			}
		} else if _, err := diff.Save(a.ws, diff.Review{Rel: ch.Rel, Old: ch.Review.Old, New: ch.Review.Old, Stamp: ch.Review.Stamp}); err != nil {
			if errors.Is(err, workspace.ErrConflict) {
				a.conflict = ch.Rel
				a.conflictOpen = true
				return
			}
			a.setNotice(Notice{Key: "noticeSaveFailed", Args: map[string]any{"err": err.Error()}})
			return
		}
		if i := a.tabOf(ch.Rel); i >= 0 {
			a.reloadPreservingCaret(ch.Rel)
		}
		restored++
	}
	a.resetReview()
	a.refreshGit(true)
	a.setNotice(Notice{Key: "noticeReviewReverted", Args: map[string]any{"count": restored}})
}
