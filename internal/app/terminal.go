package app

import (
	"sync"
	"time"

	"github.com/egoist/mygo/plugins/terminal"
)

// maxTerminals caps concurrent shells. Each one is a process tree with its own
// memory, and a bottom panel full of them is not a feature.
const maxTerminals = 4

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
func (a *App) newTerminal() { a.startTerminal(nil) }

// startTerminal runs argv in a new session in the workspace root, or the user's
// shell when argv is empty, and shows the bottom panel.
func (a *App) startTerminal(argv []string) {
	if len(a.terms) >= maxTerminals {
		a.setNotice(Notice{Key: "noticeTerminalLimit", Args: map[string]any{"max": maxTerminals}})
		return
	}
	dir := ""
	if a.ws != nil {
		dir = a.ws.Path()
	}
	a.termSeq++
	sess := &Terminal{Num: a.termSeq}
	t, err := terminal.New(terminal.Options{
		Command: argv,
		Dir:     dir,
		Font:    terminal.Font{Size: 12.5},
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
	a.selectTerminal(len(a.terms) - 1)
}

// selectTerminal shows one session in the bottom panel.
func (a *App) selectTerminal(i int) {
	if i < 0 || i >= len(a.terms) {
		return
	}
	a.Layout.ActiveTerm = i
	a.Layout.PanelTab = 0
	a.panelOpen = true
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
// quits: no shell may outlive the window that started it. Close hangs each
// program up; the wait covers one that ignores the hangup, which the plugin
// kills after two seconds.
func (a *App) closeTerminals() {
	var wg sync.WaitGroup
	for _, t := range a.terms {
		if t.Term == nil {
			continue
		}
		done := t.Term.Done()
		_ = t.Term.Close()
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case <-done:
			case <-time.After(3 * time.Second):
			}
		}()
	}
	wg.Wait()
	a.terms = nil
	a.Layout.ActiveTerm = 0
}
