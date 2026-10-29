package app

import (
	"context"

	"github.com/QinYangWang/omo/internal/commands"
	"github.com/QinYangWang/omo/internal/i18n"
	"github.com/egoist/mygo"
)

// Command IDs. The strings are a stable contract: menus, key bindings, the
// command palette and the docs will refer to them.
const (
	CmdQuit           commands.ID = "app.quit"
	CmdOpenFolder     commands.ID = "workspace.open"
	CmdCloseFolder    commands.ID = "workspace.close"
	CmdSaveFile       commands.ID = "file.save"
	CmdReviewFile     commands.ID = "file.review"
	CmdRefreshChanges commands.ID = "git.refresh"
	CmdNewTerminal    commands.ID = "terminal.new"
	CmdTogglePanel    commands.ID = "view.togglePanel"
	CmdToggleChat     commands.ID = "view.toggleChat"
)

// registerCommands runs once, from New, during startup. After that the table is
// read-only.
//
// Titles are i18n message keys; the view translates them.
func (a *App) registerCommands() {
	register := func(c commands.Command) { must(a.cmds.Register(c)) }

	register(commands.Command{
		ID:    CmdQuit,
		Title: "cmdQuit",
		Run: func(context.Context) error {
			mygo.App.Exit(0)
			return nil
		},
	})

	// The native folder dialog blocks until the user answers, so it runs off the
	// main thread and posts its result back: a view callback must not spin a
	// nested event loop (docs/architecture.md §6).
	register(commands.Command{
		ID:    CmdOpenFolder,
		Title: "cmdOpenFolder",
		Run: func(context.Context) error {
			go func() {
				paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
					Parent:      a.win,
					Directory:   true,
					Title:       i18n.T(i18n.Locale(), "cmdOpenFolder"),
					ButtonLabel: i18n.T(i18n.Locale(), "dialogOpen"),
				})
				a.post(func() {
					if err != nil {
						a.setNotice(Notice{Key: "noticeActionFailed", Args: map[string]any{"err": err.Error()}})
						return
					}
					if len(paths) == 0 {
						return
					}
					a.Dispatch(OpenWorkspace{Path: paths[0]})
				})
			}()
			return nil
		},
	})

	register(commands.Command{
		ID:    CmdCloseFolder,
		Title: "cmdCloseFolder",
		Enabled: func() bool {
			return a.ws != nil
		},
		Run: func(context.Context) error {
			a.Dispatch(CloseWorkspace{})
			return nil
		},
	})

	register(commands.Command{
		ID:    CmdSaveFile,
		Title: "cmdSaveFile",
		Enabled: func() bool {
			t := a.activeTab()
			return t != nil && t.Kind == TabFile
		},
		Run: func(context.Context) error {
			a.Dispatch(SaveFile{})
			return nil
		},
	})

	register(commands.Command{
		ID:    CmdReviewFile,
		Title: "cmdReviewFile",
		Enabled: func() bool {
			return a.ws != nil && a.activeTab() != nil
		},
		Run: func(context.Context) error {
			if t := a.activeTab(); t != nil {
				a.Dispatch(OpenDiff{Path: t.Rel})
			}
			return nil
		},
	})

	register(commands.Command{
		ID:    CmdRefreshChanges,
		Title: "cmdRefreshChanges",
		Enabled: func() bool {
			return a.repo != nil
		},
		Run: func(context.Context) error {
			a.Dispatch(RefreshChanges{})
			return nil
		},
	})

	register(commands.Command{
		ID:    CmdNewTerminal,
		Title: "cmdNewTerminal",
		Run: func(context.Context) error {
			a.Dispatch(NewTerminal{})
			return nil
		},
	})

	register(commands.Command{
		ID:    CmdTogglePanel,
		Title: "cmdTogglePanel",
		Run: func(context.Context) error {
			a.Dispatch(TogglePanel{})
			return nil
		},
	})

	register(commands.Command{
		ID:    CmdToggleChat,
		Title: "cmdToggleChat",
		Run: func(context.Context) error {
			a.Dispatch(ToggleChat{})
			return nil
		},
	})
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
