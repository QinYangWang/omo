package app

import (
	"github.com/egoist/mygo/plugins/terminal"
)

// Terminal is one shell session shown in the bottom panel.
//
// The shell runs in its own process, so a hung or crashing program cannot take
// the IDE with it. Exited and ExitCode are written on the main thread through
// post: OnExit runs on the terminal's own goroutine.
type Terminal struct {
	Num      int
	Term     *terminal.Terminal
	Exited   bool
	ExitCode int
}

// newTerminal starts a shell in the workspace root, or the home directory when
// no workspace is open.
func (a *App) newTerminal() {
	dir := ""
	if a.ws != nil {
		dir = a.ws.Path()
	}
	a.termSeq++
	sess := &Terminal{Num: a.termSeq}
	t, err := terminal.New(terminal.Options{
		Dir:  dir,
		Font: terminal.Font{Size: 12.5},
		OnExit: func(code int) {
			a.post(func() {
				sess.Exited = true
				sess.ExitCode = code
			})
		},
	})
	if err != nil {
		a.setNotice(Notice{Key: "noticeTerminalFailed", Args: map[string]any{"err": err.Error()}})
		return
	}
	// A screen with no size yet would leave the shell waiting for one: give it
	// a sane default before the first frame measures the real grid.
	t.Resize(100, 30)
	sess.Term = t
	a.terms = append(a.terms, sess)
	a.Layout.ActiveTerm = len(a.terms) - 1
	a.panelOpen = true
	a.Layout.PanelTab = 0
}

// closeTerminal kills one session and drops it.
func (a *App) closeTerminal(i int) {
	if i < 0 || i >= len(a.terms) {
		return
	}
	if t := a.terms[i]; t.Term != nil {
		_ = t.Term.Close()
	}
	a.terms = append(a.terms[:i], a.terms[i+1:]...)
	switch {
	case len(a.terms) == 0:
		a.Layout.ActiveTerm = 0
	case a.Layout.ActiveTerm >= len(a.terms):
		a.Layout.ActiveTerm = len(a.terms) - 1
	case a.Layout.ActiveTerm > i:
		a.Layout.ActiveTerm--
	}
}

// closeTerminals kills every session, as when the workspace closes or the app
// quits: no shell may outlive the window that started it.
func (a *App) closeTerminals() {
	for _, t := range a.terms {
		if t.Term != nil {
			_ = t.Term.Close()
		}
	}
	a.terms = nil
	a.Layout.ActiveTerm = 0
}
