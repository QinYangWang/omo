package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/QinYangWang/omo/internal/persistence"
)

// How much of the agent event log is kept: the newest rows, both limits.
const (
	keepEvents  = 1000
	eventMaxAge = 7 * 24 * time.Hour
)

// layoutState is what a restart puts back: the open file tabs of one workspace
// and which one was active. Diff and review tabs are not stored: they describe a
// moment, not a place.
type layoutState struct {
	Tabs   []string `json:"tabs"`
	Active int      `json:"active"`
}

// dataDir is where omo keeps its database.
func dataDir() (string, error) {
	if dir := os.Getenv("OMO_DATA_DIR"); dir != "" {
		return dir, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "omo"), nil
}

// Restore opens the metadata store and puts back the last workspace, its file
// tabs and the agent sessions it used. Call it once, from main, before the
// window exists; without it the app runs but remembers nothing.
//
// A store that cannot be opened is reported and otherwise ignored: losing layout
// history must not stop the IDE from starting (roadmap R6).
func (a *App) Restore() error {
	if a.store != nil {
		return nil
	}
	dir, err := dataDir()
	if err != nil {
		a.setNotice(Notice{Key: "noticeStoreFailed", Args: map[string]any{"err": err.Error()}})
		return err
	}
	store, err := persistence.Open(a.ctx, filepath.Join(dir, "omo.db"))
	if err != nil {
		a.setNotice(Notice{Key: "noticeStoreFailed", Args: map[string]any{"err": err.Error()}})
		return err
	}
	a.store = store
	if err := store.PruneEvents(a.ctx, keepEvents, eventMaxAge); err != nil {
		a.appendDiagnostic(err.Error())
	}
	recent, err := store.RecentWorkspaces(a.ctx, 1)
	if err != nil || len(recent) == 0 {
		return nil
	}
	// A workspace that moved or was deleted is not an error worth a dialog: the
	// app opens empty, as it did before this run.
	if _, err := os.Stat(recent[0].Path); err != nil {
		return nil
	}
	a.openWorkspace(recent[0].Path)
	a.restoreLayout()
	return nil
}

// workspaceOpened records the workspace and loads the agent sessions it had.
func (a *App) workspaceOpened() {
	a.sessions = nil
	a.layoutKey = ""
	if a.store == nil || a.WorkspacePath() == "" {
		return
	}
	path := a.WorkspacePath()
	a.layoutKey = "layout:" + path
	if err := a.store.SaveWorkspace(a.ctx, path, time.Now()); err != nil {
		a.appendDiagnostic(err.Error())
	}
	sessions, err := a.store.Sessions(a.ctx, path)
	if err != nil {
		a.appendDiagnostic(err.Error())
		return
	}
	a.sessions = make(map[string]string, len(sessions))
	for _, session := range sessions {
		if session.ACPSession != "" {
			a.sessions[session.AgentID] = session.ACPSession
		}
	}
}

// storedSession is the ACP session the agent of this workspace used last time.
func (a *App) storedSession(agentID string) string {
	if a.sessions == nil {
		return ""
	}
	return a.sessions[agentID]
}

// persistSession records the ACP session the agent created or restored, so the
// next run can ask for it back.
func (a *App) persistSession() {
	if a.store == nil || a.agents == nil || a.layoutKey == "" || a.activeAgentID == "" {
		return
	}
	_, sessionID, canLoad := a.agents.Snapshot()
	if sessionID == "" {
		return
	}
	if a.sessions == nil {
		a.sessions = make(map[string]string)
	}
	a.sessions[a.activeAgentID] = sessionID
	err := a.store.SaveSession(a.ctx, persistence.Session{
		ID:            a.WorkspacePath() + "|" + a.activeAgentID,
		AgentID:       a.activeAgentID,
		WorkspacePath: a.WorkspacePath(),
		ACPSession:    sessionID,
		CanResume:     canLoad,
		UpdatedAt:     time.Now(),
	})
	if err != nil {
		a.appendDiagnostic(err.Error())
	}
}

// saveLayout records the open file tabs, so the next run reopens them.
func (a *App) saveLayout() {
	if a.store == nil || a.layoutKey == "" {
		return
	}
	state := layoutState{Active: 0}
	activeRel := ""
	if t := a.activeTab(); t != nil && t.Kind == TabFile {
		activeRel = t.Rel
	}
	for _, tab := range a.tabs {
		if tab.Kind != TabFile {
			continue
		}
		if tab.Rel == activeRel {
			state.Active = len(state.Tabs)
		}
		state.Tabs = append(state.Tabs, tab.Rel)
	}
	blob, err := json.Marshal(state)
	if err != nil {
		a.appendDiagnostic(err.Error())
		return
	}
	if err := a.store.SaveUI(a.ctx, a.layoutKey, blob); err != nil {
		a.appendDiagnostic(err.Error())
	}
}

// restoreLayout reopens the file tabs of the open workspace.
func (a *App) restoreLayout() {
	if a.store == nil || a.layoutKey == "" || a.ws == nil {
		return
	}
	blob, ok, err := a.store.UI(a.ctx, a.layoutKey)
	if err != nil || !ok {
		return
	}
	var state layoutState
	if err := json.Unmarshal(blob, &state); err != nil {
		return
	}
	for _, rel := range state.Tabs {
		if _, err := a.ws.Stat(rel); err != nil {
			continue // moved or deleted since; skipping is not an error
		}
		a.openFile(rel)
	}
	if state.Active >= 0 && state.Active < len(a.tabs) {
		a.Layout.ActiveTab = state.Active
	}
}

// recordTurn appends one line to the event log: the outcome of a turn, never its
// content.
func (a *App) recordTurn(stopReason string) {
	if a.store == nil || a.layoutKey == "" {
		return
	}
	event := persistence.Event{
		SessionID: a.WorkspacePath() + "|" + a.activeAgentID,
		Kind:      "turn_end",
		Summary:   stopReason,
		At:        time.Now(),
	}
	if err := a.store.AppendEvents(a.ctx, []persistence.Event{event}); err != nil {
		a.appendDiagnostic(err.Error())
	}
}

// closeStore saves what this run changed and closes the database.
func (a *App) closeStore() {
	if a.store == nil {
		return
	}
	a.saveLayout()
	if err := a.store.Close(); err != nil {
		a.appendDiagnostic(err.Error())
	}
	a.store = nil
}
