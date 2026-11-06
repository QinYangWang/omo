package app

import (
	"github.com/QinYangWang/omo/internal/commands"
	"github.com/QinYangWang/omo/internal/i18n"
	"github.com/egoist/mygo"
)

// Menu builds the native menu bar: the platform's own menu, not a drawn one.
//
// Labels are translated when the menu is built, so it follows the language the
// app starts in; MyGo relabels the items that come from roles on its own.
// Rebuilding on a live language change is a P2 concern.
func (a *App) Menu() *mygo.Menu {
	loc := i18n.Locale()
	t := func(key string) string { return i18n.T(loc, key) }
	run := func(id commands.ID) func(*mygo.MenuItem, *mygo.Window) {
		return func(*mygo.MenuItem, *mygo.Window) { a.Run(id) }
	}

	return mygo.NewMenu([]*mygo.MenuItem{
		{
			Label: "omo",
			Submenu: []*mygo.MenuItem{
				{Role: mygo.RoleQuit},
			},
		},
		{
			ID:    "file",
			Label: t("menuFile"),
			Submenu: []*mygo.MenuItem{
				{Label: t("cmdNewSession"), Accelerator: "CmdOrCtrl+N", Click: run(CmdNewSession)},
				{Label: t("cmdOpenFolder"), Accelerator: "CmdOrCtrl+Shift+O", Click: run(CmdOpenFolder)},
				{Label: t("cmdCloseFolder"), Click: run(CmdCloseFolder)},
				mygo.Separator(),
				{Label: t("cmdSaveFile"), Accelerator: "CmdOrCtrl+S", Click: run(CmdSaveFile)},
				{Label: t("cmdReviewFile"), Click: run(CmdReviewFile)},
				mygo.Separator(),
				{Label: t("cmdSettings"), Accelerator: "CmdOrCtrl+,", Click: run(CmdSettings)},
			},
		},
		{
			ID:    "edit",
			Label: t("menuEdit"),
			Submenu: []*mygo.MenuItem{
				{Role: mygo.RoleUndo},
				{Role: mygo.RoleRedo},
				mygo.Separator(),
				{Role: mygo.RoleCut},
				{Role: mygo.RoleCopy},
				{Role: mygo.RolePaste},
				{Role: mygo.RoleSelectAll},
			},
		},
		{
			ID:    "view",
			Label: t("menuView"),
			Submenu: []*mygo.MenuItem{
				{Label: t("cmdSearch"), Accelerator: "CmdOrCtrl+K", Click: run(CmdSearch)},
				{Label: t("cmdSchedule"), Click: run(CmdSchedule)},
				mygo.Separator(),
				{Label: t("cmdToggleLeft"), Accelerator: "CmdOrCtrl+B", Click: run(CmdToggleLeft)},
				{Label: t("cmdToggleRight"), Accelerator: "CmdOrCtrl+Shift+C", Click: run(CmdToggleRight)},
				{Label: t("cmdTogglePanel"), Accelerator: "CmdOrCtrl+Shift+D", Click: run(CmdTogglePanel)},
				{Label: t("cmdToggleTheme"), Click: run(CmdToggleTheme)},
				{Label: t("cmdNewTerminal"), Accelerator: "CmdOrCtrl+Shift+T", Click: run(CmdNewTerminal)},
				mygo.Separator(),
				{Label: t("cmdRefreshChanges"), Click: run(CmdRefreshChanges)},
				{Label: t("cmdStageChanges"), Click: run(CmdStageChanges)},
			},
		},
	})
}
