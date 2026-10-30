package view

import (
	"runtime"
	"strings"

	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/git"
	"github.com/QinYangWang/omo/internal/i18n"
	"github.com/QinYangWang/omo/internal/kit"
	"github.com/egoist/mygo/ui"
)

// Shell is the whole window: the header, the sessions panel on the left, the
// middle area (tab strip, editor or session, bottom panel), the right sidebar
// and the status bar.
//
// Panels are separated by 1 DIP rules; the chrome shares one surface and the
// editor keeps the window background, so the code is the brightest thing in the
// window. The bottom panel gives its room back when hidden, and both sidebars
// collapse to give the middle the room.
func Shell(c *ui.Context, a *app.App) {
	a.NoteFrame()
	st := kit.New(c)
	ui.Column(c).Fill().Background(st.BG).Children(func() {
		appHeader(c, a, st)
		st.HRule(c)
		ui.Row(c).Grow(1).Children(func() {
			if a.LeftOpen() {
				sessionsPanel(c, a, st)
				st.VRule(c)
			}
			mainArea(c, a, st)
			if a.RightOpen() {
				st.VRule(c)
				rightSidebar(c, a, st)
			}
		})
		st.HRule(c)
		statusBar(c, a, st)
	})
	conflictDialog(c, a, st)
	agentDialogs(c, a, st)
}

// appHeader is the window's title bar, drawn by the window itself because the
// system's title bar is hidden: the sessions toggle and the app's mark on the
// left, the workspace it has open, and the panel toggles on the right. The row
// moves the window; the window controls sit over its right end.
func appHeader(c *ui.Context, a *app.App, st kit.Theme) {
	loc := c.Locale()
	bar := c.TitleBar()
	right := bar.Right + 8
	if runtime.GOOS == "linux" && bar.Right > 0 {
		right = bar.Right - 2
	}
	ui.Row(c).Height(max(bar.Height, st.HeadH)).Padding(0, right, 0, bar.Left+st.Pad).
		Gap(2).AlignItems(ui.Center).Background(st.Panel).DragWindow().Children(func() {
		st.IconButton(c, kit.IconSidebarLeft, i18n.T(loc, "cmdToggleLeft"), a.LeftOpen(), func() {
			a.Dispatch(app.ToggleLeft{})
		})
		ui.Icon(c, kit.IconLogo).FontSize(16).TextColor(st.Accent).PaddingX(3)
		ui.Text(c, "omo").FontSize(st.FontUI).Bold().TextColor(st.Text).PaddingX(5)
		ui.Box(c).Width(1).Height(14).Background(st.Border).MarginX(4)
		if name := a.WorkspaceName(); name != "" {
			ui.Icon(c, kit.IconFolder).FontSize(13).TextColor(st.Faint).PaddingX(4)
			ui.Text(c, name).FontSize(st.FontUI).TextColor(st.Muted).SingleLine()
		} else {
			ui.Text(c, i18n.T(loc, "statusNoWorkspace")).FontSize(st.FontUI).TextColor(st.Faint).
				SingleLine().PaddingX(4)
		}
		ui.Spacer(c)
		st.IconButton(c, kit.IconPanel, i18n.T(loc, "panelToggle"), a.PanelOpen(), func() {
			a.Dispatch(app.TogglePanel{})
		})
		st.IconButton(c, kit.IconSidebarRight, i18n.T(loc, "cmdToggleRight"), a.RightOpen(), func() {
			a.Dispatch(app.ToggleRight{})
		})
	})
}

// mainArea is the middle column: the tabs and their pane, with the bottom panel
// under them when it is open.
func mainArea(c *ui.Context, a *app.App, st kit.Theme) {
	ui.Column(c).Grow(1).FillHeight().Children(func() {
		if a.PanelOpen() {
			ui.SplitVerticalPercent(c, &a.Layout.MainRows,
				func() { editorPane(c, a, st) },
				func() { bottomPane(c, a, st) },
			).Grow(1).FillHeight()
			return
		}
		editorPane(c, a, st)
	})
}

// sessionsPanel is the left column: the open project and everything open in it.
// It is the way back to a tab or a terminal the middle is not showing.
func sessionsPanel(c *ui.Context, a *app.App, st kit.Theme) {
	loc := c.Locale()
	ui.Column(c).Width(st.LeftW).FillHeight().Background(st.Panel).Children(func() {
		ui.Row(c).Height(st.TitleH).PaddingX(st.Pad).Gap(4).AlignItems(ui.Center).Children(func() {
			st.SectionLabel(c, i18n.T(loc, "sessionsTitle"))
			ui.Spacer(c)
			st.IconButton(c, kit.IconPlus, i18n.T(loc, "terminalNew"), false, func() {
				a.Dispatch(app.NewTerminal{})
			})
		})
		ui.Row(c).PaddingX(st.Pad).PaddingY(st.Gap).Children(func() {
			ui.SearchField(c, &a.Layout.SessionQuery).Grow(1).Label(i18n.T(loc, "sessionsSearch"))
		})
		st.HRule(c)
		ui.Scroll(c).Grow(1).Children(func() { sessionsList(c, a, st) })
	})
}

func sessionsList(c *ui.Context, a *app.App, st kit.Theme) {
	loc := c.Locale()
	query := strings.ToLower(strings.TrimSpace(a.Layout.SessionQuery))
	match := func(s string) bool {
		return query == "" || strings.Contains(strings.ToLower(s), query)
	}

	if a.WorkspaceName() == "" {
		ui.Column(c).Padding(st.Pad).Gap(6).Children(func() {
			ui.Text(c, i18n.T(loc, "statusNoWorkspace")).FontSize(st.FontMeta).TextColor(st.Muted)
			st.ActionRow(c, kit.IconFolderOpen, i18n.T(loc, "cmdOpenFolder"), "", func() {
				a.Run(app.CmdOpenFolder)
			})
		})
		return
	}

	// The project, with what is worth knowing at a glance: the branch, or the
	// number of paths that differ from HEAD. A click brings the files back.
	name := a.WorkspaceName()
	meta := i18n.T(loc, "statusNoRepo")
	if b := a.Branch(); b != "" {
		meta = b
	}
	if n := a.ChangesCount(); n > 0 {
		meta = i18n.Tf(loc, "changesCount", map[string]any{"count": n})
	}
	if match(name) {
		st.Row(c, kit.RowSpec{
			Icon:   kit.IconFolder,
			Label:  name,
			Meta:   meta,
			Tip:    a.WorkspacePath(),
			Active: a.Layout.RightSel == "files",
			OnClick: func() {
				a.Dispatch(app.ShowPanel{Name: "files"})
			},
		})
	}

	terminals := a.Terminals()
	tabs := a.Tabs()
	if len(tabs) == 0 && len(terminals) == 0 {
		ui.Text(c, i18n.T(loc, "sessionsEmpty")).FontSize(st.FontMeta).TextColor(st.Muted).
			PaddingX(st.Pad).PaddingY(4)
		return
	}

	if len(tabs) > 0 {
		st.SectionRow(c, i18n.T(loc, "sessionsOpen"))
		for i, tab := range tabs {
			index := i
			label := tabTitle(a, tab, loc)
			if !match(label) {
				continue
			}
			icon, clr := tabIcon(st, tab)
			st.Row(c, kit.RowSpec{
				Icon:    icon,
				IconClr: clr,
				Dot:     tab.Kind == app.TabFile && a.Dirty(tab.Rel),
				Label:   label,
				Active:  i == a.Layout.ActiveTab,
				Tip:     tab.Rel,
				OnClick: func() { a.Layout.ActiveTab = index },
			})
		}
	}

	if len(terminals) > 0 {
		st.SectionRow(c, i18n.T(loc, "panelTerminal"))
		for i, t := range terminals {
			index := i
			label := i18n.Tf(loc, "terminalTitle", map[string]any{"num": t.Num})
			if t.Exited {
				label = i18n.Tf(loc, "terminalExited", map[string]any{"num": t.Num, "code": t.ExitCode})
			}
			if !match(label) {
				continue
			}
			st.Row(c, kit.RowSpec{
				Icon:   kit.IconTerminal,
				Label:  label,
				Active: a.PanelOpen() && a.Layout.PanelTab == 0 && i == a.Layout.ActiveTerm,
				OnClick: func() {
					a.Dispatch(app.SelectTerminal{Index: index})
				},
			})
		}
	}
}

// rightSidebar is the right column: one icon strip choosing the page, then the
// page itself. Files, search and changes browse the open project; run holds the
// workspace's quick commands; browser opens an address in the user's browser.
func rightSidebar(c *ui.Context, a *app.App, st kit.Theme) {
	ui.Column(c).Width(st.RightW).FillHeight().Background(st.Panel).Children(func() {
		rightHeader(c, a, st)
		st.HRule(c)
		switch a.Layout.RightSel {
		case "search":
			searchPanel(c, a, st)
		case "git":
			changesPanel(c, a, st)
		case "run":
			runPanel(c, a, st)
		case "browser":
			browserPanel(c, a, st)
		default:
			explorerPanel(c, a, st)
		}
	})
}

func rightHeader(c *ui.Context, a *app.App, st kit.Theme) {
	loc := c.Locale()
	page := func(id string) func() { return func() { a.Layout.RightSel = id } }
	active := func(id string) bool { return a.Layout.RightSel == id }
	st.IconTabs(c, []kit.IconTab{
		{Icon: kit.IconFiles, Label: i18n.T(loc, "sidebarFiles"), Active: active("files"), OnClick: page("files")},
		{Icon: kit.IconSearch, Label: i18n.T(loc, "sidebarSearch"), Active: active("search"), OnClick: page("search")},
		{Icon: kit.IconGit, Label: i18n.T(loc, "sidebarGit"), Active: active("git"), OnClick: page("git")},
		{Icon: kit.IconRun, Label: i18n.T(loc, "sidebarRun"), Active: active("run"), OnClick: page("run")},
		{Icon: kit.IconGlobe, Label: i18n.T(loc, "sidebarBrowser"), Active: active("browser"), OnClick: page("browser")},
	})
}

// explorerPanel is the files page: the tree of the open project.
func explorerPanel(c *ui.Context, a *app.App, st kit.Theme) {
	loc := c.Locale()
	if a.WorkspaceName() == "" {
		// Nothing is open: an empty state, not a section header over nothing.
		st.EmptyState(c, kit.IconFolderOpen, i18n.T(loc, "explorerNoFolder"))
		return
	}
	ui.Column(c).Fill().Children(func() {
		st.SectionHeader(c, workspaceTitle(a, loc), &a.Layout.ExplorerOpen)
		if !a.Layout.ExplorerOpen {
			return
		}
		if len(a.Files()) == 0 {
			ui.Text(c, i18n.T(loc, "explorerEmpty")).FontSize(st.FontMeta).TextColor(st.Muted).
				PaddingX(st.Pad).PaddingY(4)
			return
		}
		ui.Scroll(c).Grow(1).Children(func() {
			fileRows(c, a, st, a.Files(), 0)
		})
	})
}

// fileRows renders the tree: a disclosure chevron for directories, a file-type
// icon, an indent per level and a dot for files with unsaved text. Children load
// the first time they are shown.
func fileRows(c *ui.Context, a *app.App, st kit.Theme, nodes []*app.FileNode, depth int) {
	indent := float32(depth) * 14
	for _, n := range nodes {
		if !n.IsDir {
			rel := n.Rel
			icon, clr := st.FileIcon(n.Name)
			st.Row(c, kit.RowSpec{
				Indent:  indent + 18,
				Icon:    icon,
				IconClr: clr,
				Dot:     a.Dirty(rel),
				Label:   n.Name,
				Active:  isActiveFile(a, rel),
				Tip:     rel,
				OnClick: func() { a.Dispatch(app.OpenFile{Path: rel}) },
			})
			continue
		}
		arrow := kit.IconChevronRight
		folder := kit.IconFolder
		if n.Open {
			arrow = kit.IconChevronDown
			folder = kit.IconFolderOpen
		}
		node := n
		st.Row(c, kit.RowSpec{
			Indent: indent,
			Arrow:  arrow,
			Icon:   folder,
			Label:  node.Name,
			Tip:    node.Rel,
			OnClick: func() {
				node.Open = !node.Open
			},
		})
		if !node.Open {
			continue
		}
		a.LoadChildren(node)
		if node.LoadErr != "" {
			ui.Text(c, node.LoadErr).FontSize(st.FontMeta).TextColor(st.Danger).PaddingX(st.Pad)
			continue
		}
		fileRows(c, a, st, node.Children, depth+1)
	}
}

func searchPanel(c *ui.Context, a *app.App, st kit.Theme) {
	st.EmptyState(c, kit.IconSearch, i18n.T(c.Locale(), "searchPlaceholder"))
}

// changesPanel lists the paths that differ from HEAD: the entry point for
// reviewing what a terminal agent changed.
func changesPanel(c *ui.Context, a *app.App, st kit.Theme) {
	loc := c.Locale()
	if a.WorkspaceName() != "" && a.Branch() == "" {
		st.EmptyState(c, kit.IconGit, i18n.T(loc, "gitPlaceholder"))
		return
	}
	ui.Row(c).Height(st.RowH + 4).PaddingX(st.Pad).Gap(4).AlignItems(ui.Center).Children(func() {
		st.SectionLabel(c, i18n.T(loc, "sectionChanges"))
		ui.Spacer(c)
		if len(a.Changes()) > 0 {
			st.IconButton(c, kit.IconPlus, i18n.T(loc, "changesStage"), false, func() {
				a.Dispatch(app.StageChanges{})
			})
		}
		st.IconButton(c, kit.IconRefresh, i18n.T(loc, "changesRefresh"), false, func() {
			a.Dispatch(app.RefreshChanges{})
		})
	})
	if len(a.Changes()) == 0 {
		st.EmptyState(c, kit.IconDiff, i18n.T(loc, "changesEmpty"))
		return
	}
	ui.Scroll(c).Grow(1).Children(func() {
		for _, ch := range a.Changes() {
			rel := ch.Path
			icon, clr := st.FileIcon(baseName(rel))
			st.Row(c, kit.RowSpec{
				Icon:    icon,
				IconClr: clr,
				Label:   rel,
				Meta:    ch.Status,
				MetaClr: changeColor(st, ch),
				Tip:     rel,
				OnClick: func() { a.Dispatch(app.OpenDiff{Path: rel}) },
			})
		}
	})
}

// changeColor colors a git status letter: staged changes read as settled,
// work-tree-only ones as pending.
func changeColor(st kit.Theme, ch git.Change) ui.Color {
	switch {
	case ch.Status == "?":
		return st.Muted
	case ch.Status == "D":
		return st.Danger
	case ch.Staged:
		return st.Success
	}
	return st.Warning
}

// quickCommand is one shortcut of the run page.
type quickCommand struct {
	key  string // the label's message key
	args []string
}

// quickCommands is what the run page offers for this workspace: Go's build,
// test and vet when go.mod is at the root, make when a Makefile is. Adding a
// language is adding a case here.
func quickCommands(a *app.App) []quickCommand {
	names := make(map[string]bool, len(a.Files()))
	for _, n := range a.Files() {
		names[n.Name] = true
	}
	var cmds []quickCommand
	if names["go.mod"] {
		cmds = append(cmds,
			quickCommand{key: "runBuild", args: []string{"go", "build", "./..."}},
			quickCommand{key: "runTest", args: []string{"go", "test", "./..."}},
			quickCommand{key: "runVet", args: []string{"go", "vet", "./..."}},
		)
	}
	if names["Makefile"] || names["makefile"] {
		cmds = append(cmds, quickCommand{key: "runMake", args: []string{"make"}})
	}
	return cmds
}

// runPanel is the run and debug page: the workspace's quick commands, each in
// its own terminal, and a shell when none of them is what you want.
func runPanel(c *ui.Context, a *app.App, st kit.Theme) {
	loc := c.Locale()
	if a.WorkspaceName() == "" {
		st.EmptyState(c, kit.IconRun, i18n.T(loc, "statusNoWorkspace"))
		return
	}
	ui.Column(c).Fill().Padding(st.Gap).Gap(2).Children(func() {
		cmds := quickCommands(a)
		st.SectionRow(c, i18n.T(loc, "runQuick"))
		for _, cmd := range cmds {
			args := cmd.args
			st.ActionRow(c, kit.IconRun, i18n.T(loc, cmd.key), strings.Join(args, " "), func() {
				a.Dispatch(app.RunCommand{Args: args})
			})
		}
		if len(cmds) == 0 {
			ui.Text(c, i18n.T(loc, "runNothing")).FontSize(st.FontMeta).TextColor(st.Muted).
				PaddingX(4).PaddingY(4)
		}
		st.ActionRow(c, kit.IconTerminal, i18n.T(loc, "terminalNew"), newTerminalKeys(), func() {
			a.Run(app.CmdNewTerminal)
		})
		ui.Text(c, i18n.T(loc, "runHint")).FontSize(st.FontMeta).TextColor(st.Faint).Padding(8, 4)
	})
}

// browserPanel is the browser page: an address, and the user's browser opened on
// it. A page drawn inside the window is not what this is for.
func browserPanel(c *ui.Context, a *app.App, st kit.Theme) {
	loc := c.Locale()
	ui.Column(c).Fill().Padding(st.Pad).Gap(st.Gap).Children(func() {
		ui.Row(c).Gap(st.Gap).Children(func() {
			ui.TextInput(c, &a.Layout.BrowserURL).Grow(1).Label(i18n.T(loc, "browserAddress")).
				Placeholder(i18n.T(loc, "browserHint"))
			if ui.Button(c, i18n.T(loc, "browserOpen")).Clicked() {
				a.Dispatch(app.OpenURL{URL: a.Layout.BrowserURL})
			}
		})
		ui.Text(c, i18n.T(loc, "browserOpenHint")).FontSize(st.FontMeta).TextColor(st.Faint)
	})
}

// isActiveFile reports whether rel is the file open in the active tab, so the
// tree can mark it.
func isActiveFile(a *app.App, rel string) bool {
	t := a.TabAt(a.Layout.ActiveTab)
	return t != nil && t.Kind == app.TabFile && t.Rel == rel
}

func workspaceTitle(a *app.App, locale string) string {
	if name := a.WorkspaceName(); name != "" {
		return name
	}
	return i18n.T(locale, "statusNoWorkspace")
}
