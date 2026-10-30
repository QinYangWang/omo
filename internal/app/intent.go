package app

import (
	"errors"
	"strings"

	"github.com/QinYangWang/omo/internal/agent"
	"github.com/QinYangWang/omo/internal/diff"
	"github.com/QinYangWang/omo/internal/workspace"
	"github.com/egoist/mygo"
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

// OpenReview lists the files the agent changed.
type OpenReview struct{}

// AcceptReview keeps the agent's changes and starts a new baseline.
type AcceptReview struct{}

// RejectReview puts every file the agent changed back, deleting the files it
// created.
type RejectReview struct{}

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

// ToggleLeft shows or hides the sessions panel.
type ToggleLeft struct{}

// ToggleRight shows or hides the right sidebar.
type ToggleRight struct{}

// ShowPanel opens the right sidebar on one of its pages.
type ShowPanel struct{ Name string }

// SelectTerminal shows the bottom panel on one terminal session.
type SelectTerminal struct{ Index int }

// RunCommand runs argv in a new terminal in the workspace root.
type RunCommand struct{ Args []string }

// OpenURL opens a URL in the user's browser.
type OpenURL struct{ URL string }

// NewTerminal starts a shell in the bottom panel.
type NewTerminal struct{}

// CloseTerminal kills one terminal session.
type CloseTerminal struct{ Index int }

// RefreshChanges re-reads git status.
type RefreshChanges struct{}

// StageChanges adds every changed path to the git index.
type StageChanges struct{}

// OpenWorkspace opens a workspace directory.
type OpenWorkspace struct{ Path string }

// CloseWorkspace closes the current workspace.
type CloseWorkspace struct{}

// SelectAgent selects a configured agent without starting it.
type SelectAgent struct{ ID string }

// StartAgent starts the selected agent after the first-run trust check.
type StartAgent struct{ ID string }

// SendPrompt sends the current input, starting the agent when necessary.
type SendPrompt struct{}

// CancelTurn cancels the active turn and all pending approvals.
type CancelTurn struct{}

// RestartAgent reconnects and restores the session when supported.
type RestartAgent struct{}

// ResolvePermission answers the pending request with one of its ACP options.
type ResolvePermission struct{ OptionID string }

// TrustAgent confirms execution of a third-party local program.
type TrustAgent struct{ ID string }

// ShowAgents opens the agent catalog.
type ShowAgents struct{}

// CloseAgents closes the agent catalog without changing the selection.
type CloseAgents struct{}

// EditAgentConfig opens a new or existing agent definition.
type EditAgentConfig struct{ ID string }

// CloseAgentConfig dismisses the definition form.
type CloseAgentConfig struct{}

// SaveAgentConfig validates and saves the form.
type SaveAgentConfig struct{}

// DeleteAgent removes a definition and stops it if active.
type DeleteAgent struct{ ID string }

// UpdateAgent installs the latest version of a known agent's package.
type UpdateAgent struct{ ID string }

func (OpenFile) isIntent()          {}
func (CloseTab) isIntent()          {}
func (SaveFile) isIntent()          {}
func (OpenDiff) isIntent()          {}
func (OpenReview) isIntent()        {}
func (AcceptReview) isIntent()      {}
func (RejectReview) isIntent()      {}
func (ApplyReview) isIntent()       {}
func (ResolveConflict) isIntent()   {}
func (TogglePanel) isIntent()       {}
func (ToggleLeft) isIntent()        {}
func (ToggleRight) isIntent()       {}
func (ShowPanel) isIntent()         {}
func (SelectTerminal) isIntent()    {}
func (RunCommand) isIntent()        {}
func (OpenURL) isIntent()           {}
func (NewTerminal) isIntent()       {}
func (CloseTerminal) isIntent()     {}
func (RefreshChanges) isIntent()    {}
func (StageChanges) isIntent()      {}
func (OpenWorkspace) isIntent()     {}
func (CloseWorkspace) isIntent()    {}
func (SelectAgent) isIntent()       {}
func (StartAgent) isIntent()        {}
func (SendPrompt) isIntent()        {}
func (CancelTurn) isIntent()        {}
func (RestartAgent) isIntent()      {}
func (ResolvePermission) isIntent() {}
func (TrustAgent) isIntent()        {}
func (ShowAgents) isIntent()        {}
func (CloseAgents) isIntent()       {}
func (EditAgentConfig) isIntent()   {}
func (CloseAgentConfig) isIntent()  {}
func (SaveAgentConfig) isIntent()   {}
func (DeleteAgent) isIntent()       {}
func (UpdateAgent) isIntent()       {}

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
	case OpenReview:
		a.openReview()
	case AcceptReview:
		a.acceptReview()
	case RejectReview:
		a.rejectReview()
	case ApplyReview:
		a.applyReview()
	case ResolveConflict:
		a.resolveConflict(v.Choice)
	case TogglePanel:
		a.panelOpen = !a.panelOpen
	case ToggleLeft:
		a.leftOpen = !a.leftOpen
	case ToggleRight:
		a.rightOpen = !a.rightOpen
	case ShowPanel:
		a.Layout.RightSel = v.Name
		a.rightOpen = true
	case SelectTerminal:
		a.selectTerminal(v.Index)
	case RunCommand:
		a.startTerminal(v.Args)
	case OpenURL:
		a.openURL(v.URL)
	case NewTerminal:
		a.newTerminal()
	case CloseTerminal:
		a.closeTerminal(v.Index)
	case RefreshChanges:
		a.refreshGit(true)
	case StageChanges:
		a.stageChanges()
	case OpenWorkspace:
		a.openWorkspace(v.Path)
	case CloseWorkspace:
		a.closeWorkspace()
	case SelectAgent:
		if _, ok := a.agentDefinition(v.ID); ok && a.activeAgentID != v.ID {
			a.closeAgent()
			a.activeAgentID = v.ID
			a.chatItems = nil
		}
		a.agentPicker = false
	case StartAgent:
		a.startAgent(v.ID)
	case SendPrompt:
		a.sendPrompt()
	case CancelTurn:
		a.cancelTurn()
	case RestartAgent:
		if a.AgentState() == agent.StateStarting || a.AgentState() == agent.StatePrompting || a.AgentState() == agent.StateCancelling {
			a.setNotice(Notice{Key: "agentBusy"})
		} else if def, ok := a.agentDefinition(a.activeAgentID); ok && def.Trusted && a.WorkspacePath() != "" {
			a.runAgent(def, "", true)
		}
	case ResolvePermission:
		a.resolvePermission(v.OptionID)
	case TrustAgent:
		a.trustAgent(v.ID)
	case ShowAgents:
		a.agentPicker = true
	case CloseAgents:
		a.agentPicker = false
	case EditAgentConfig:
		a.editAgentConfig(v.ID)
	case CloseAgentConfig:
		a.agentConfig.Open = false
	case SaveAgentConfig:
		a.saveAgentConfig()
	case DeleteAgent:
		a.deleteAgent(v.ID)
	case UpdateAgent:
		a.updateAgent(v.ID)
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

// openDiff shows a review of rel: against the text it had before the agent
// touched it when the agent changed it, else against HEAD in a repository, else
// against the saved version when the buffer has unsaved text.
func (a *App) openDiff(rel string) {
	if a.ws == nil {
		a.setNotice(Notice{Key: "noticeNeedWorkspace"})
		return
	}
	if i := a.diffTabOf(rel); i >= 0 {
		a.Layout.ActiveTab = i
		return
	}
	if ch := a.changeFor(rel); ch != nil {
		// The change's own diff state is reused, so per-hunk decisions survive
		// closing and reopening the tab.
		a.tabs = append(a.tabs, Tab{Kind: TabDiff, Rel: rel, Diff: ch.Diff, Review: ch.Review})
		a.Layout.ActiveTab = len(a.tabs) - 1
		return
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
	a.refreshReview()
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

// browserURL is the address to open for what the user typed: a bare host is
// taken as https, anything with a scheme is kept.
func browserURL(raw string) (string, bool) {
	u := strings.TrimSpace(raw)
	if u == "" {
		return "", false
	}
	if !strings.Contains(u, "://") {
		u = "https://" + u
	}
	return u, true
}

// openURL opens the browser panel's address in the user's browser.
func (a *App) openURL(raw string) {
	u, ok := browserURL(raw)
	if !ok {
		a.setNotice(Notice{Key: "noticeURLInvalid"})
		return
	}
	if err := mygo.Shell.OpenExternal(u); err != nil {
		a.setNotice(Notice{Key: "noticeURLFailed", Args: map[string]any{"url": u, "err": err.Error()}})
		return
	}
	a.Layout.BrowserURL = u
}

// changeStatus returns the git status letter of a path, or "".
func (a *App) changeStatus(rel string) string {
	for _, c := range a.changes {
		if c.Path == rel {
			return c.Status
		}
	}
	return ""
}
