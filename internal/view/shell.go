package view

import (
	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/i18n"
	"github.com/egoist/mygo/ui"
)

// Shell is the whole window: activity rail, side panel, editor with the chat
// panel beside it, bottom panel and status bar.
//
// Panels are separated by 1 DIP rules and share the window background; only
// interactive surfaces take the theme's surface color. The bottom panel gives
// its room back to the editor when hidden, and the chat panel can be dragged or
// closed.
func Shell(c *ui.Context, a *app.App) {
	a.NoteFrame()
	st := newStyle(c)
	ui.Column(c).Fill().Background(st.bg).Children(func() {
		ui.Row(c).Grow(1).Children(func() {
			activityRail(c, a, st)
			st.vrule(c)
			sidePanel(c, a, st)
			st.vrule(c)
			if a.PanelOpen() {
				ui.SplitVerticalPercent(c, &a.Layout.MainRows,
					func() { middleRow(c, a, st) },
					func() { bottomPane(c, a, st) },
				).Grow(1).FillHeight()
				return
			}
			middleRow(c, a, st)
		})
		st.hrule(c)
		statusBar(c, a, st)
	})
	conflictDialog(c, a, st)
}

// activityRail is the icon strip that chooses the side panel's content.
func activityRail(c *ui.Context, a *app.App, st style) {
	loc := c.Locale()
	ui.Column(c).Width(st.railW).FillHeight().Background(st.panel).PaddingY(6).Gap(2).Children(func() {
		railItem(c, a, st, "explorer", iconFiles, i18n.T(loc, "sectionExplorer"))
		railItem(c, a, st, "search", iconSearch, i18n.T(loc, "sectionSearch"))
		railItem(c, a, st, "git", iconGit, i18n.T(loc, "sectionChanges"))
	})
}

func railItem(c *ui.Context, a *app.App, st style, id string, icon *ui.SVG, label string) {
	active := a.Layout.ActivitySel == id
	e := ui.Box(c).Width(st.railW).Height(st.railW).Justify(ui.Center).AlignItems(ui.Center).Focusable().Label(label)
	e = e.Children(func() {
		ui.Icon(c, icon).FontSize(16).TextColor(st.iconColor(active))
	})
	switch {
	case active:
		e.Background(st.hover)
	case e.Hovered():
		e.Background(st.selected)
	}
	e.OnClick(func() { a.Layout.ActivitySel = id })
}

// sidePanel shows one of the explorer, search or git views.
func sidePanel(c *ui.Context, a *app.App, st style) {
	ui.Column(c).Width(st.sideW).FillHeight().Background(st.panel).Children(func() {
		title := i18n.T(c.Locale(), "sectionExplorer")
		switch a.Layout.ActivitySel {
		case "search":
			title = i18n.T(c.Locale(), "sectionSearch")
		case "git":
			title = i18n.T(c.Locale(), "sectionChanges")
		}
		ui.Row(c).Height(st.titleH).PaddingX(st.pad).AlignItems(ui.Center).Children(func() {
			ui.Text(c, title).FontSize(st.fsMeta).TextColor(st.muted).Bold()
		})
		st.hrule(c)
		switch a.Layout.ActivitySel {
		case "search":
			searchPanel(c, a, st)
		case "git":
			changesPanel(c, a, st)
		default:
			explorerPanel(c, a, st)
		}
	})
}

func explorerPanel(c *ui.Context, a *app.App, st style) {
	loc := c.Locale()
	if a.WorkspaceName() == "" {
		// Nothing is open: an empty state, not a section header over nothing.
		ui.Column(c).Fill().Padding(st.pad).Gap(st.gap).Children(func() {
			ui.Text(c, i18n.T(loc, "statusNoWorkspace")).FontSize(st.fsUI).TextColor(st.text)
			ui.Text(c, i18n.T(loc, "explorerNoFolder")).FontSize(st.fsMeta).TextColor(st.muted)
		})
		return
	}
	ui.Column(c).Fill().Children(func() {
		sectionHeader(c, a, st, workspaceTitle(a, loc), &a.Layout.ExplorerOpen)
		if !a.Layout.ExplorerOpen {
			return
		}
		if len(a.Files()) == 0 {
			ui.Text(c, i18n.T(loc, "explorerEmpty")).FontSize(st.fsMeta).TextColor(st.muted).PaddingX(st.pad).PaddingY(4)
			return
		}
		ui.Scroll(c).Grow(1).Children(func() {
			fileRows(c, a, st, a.Files(), 0)
		})
	})
}

// sectionHeader is a collapsible section label with a chevron.
func sectionHeader(c *ui.Context, a *app.App, st style, title string, open *bool) {
	e := ui.Row(c).Height(st.rowH).PaddingX(st.gap).Gap(st.gap).AlignItems(ui.Center)
	e = e.Children(func() {
		icon := iconChevronRight
		if *open {
			icon = iconChevronDown
		}
		ui.Icon(c, icon).FontSize(12).TextColor(st.muted)
		ui.Text(c, title).FontSize(st.fsList).TextColor(st.text)
	})
	if e.Hovered() {
		e.Background(st.hover)
	}
	e.OnClick(func() { *open = !*open })
}

// fileRows renders the tree: a chevron for directories, an indent per level and a
// dot for files with unsaved text. Children load the first time they are shown.
func fileRows(c *ui.Context, a *app.App, st style, nodes []*app.FileNode, depth int) {
	indent := float32(depth) * 12
	for _, n := range nodes {
		if !n.IsDir {
			rel := n.Rel
			st.row(c, rowSpec{
				indent: indent + 20,
				dot:    a.Dirty(rel),
				label:  n.Name,
				onClick: func() {
					a.Dispatch(app.OpenFile{Path: rel})
				},
			})
			continue
		}
		icon := iconChevronRight
		if n.Open {
			icon = iconChevronDown
		}
		node := n
		st.row(c, rowSpec{
			indent:  indent,
			icon:    icon,
			label:   node.Name,
			onClick: func() { node.Open = !node.Open },
		})
		if !node.Open {
			continue
		}
		a.LoadChildren(node)
		if node.LoadErr != "" {
			ui.Text(c, node.LoadErr).FontSize(st.fsMeta).TextColor(st.danger).PaddingX(st.pad)
			continue
		}
		fileRows(c, a, st, node.Children, depth+1)
	}
}

func searchPanel(c *ui.Context, a *app.App, st style) {
	ui.Text(c, i18n.T(c.Locale(), "searchPlaceholder")).FontSize(st.fsMeta).TextColor(st.muted).Padding(st.pad)
}

// changesPanel lists the paths that differ from HEAD: the entry point for
// reviewing what a terminal agent changed.
func changesPanel(c *ui.Context, a *app.App, st style) {
	loc := c.Locale()
	ui.Row(c).Height(st.titleH).PaddingX(st.pad).AlignItems(ui.Center).Children(func() {
		if ui.Button(c, i18n.T(loc, "changesRefresh")).Clicked() {
			a.Dispatch(app.RefreshChanges{})
		}
	})
	if a.WorkspaceName() != "" && a.Branch() == "" {
		ui.Text(c, i18n.T(loc, "gitPlaceholder")).FontSize(st.fsMeta).TextColor(st.muted).Padding(st.pad)
		return
	}
	if len(a.Changes()) == 0 {
		ui.Text(c, i18n.T(loc, "changesEmpty")).FontSize(st.fsMeta).TextColor(st.muted).Padding(st.pad)
		return
	}
	ui.Scroll(c).Grow(1).Children(func() {
		for _, ch := range a.Changes() {
			rel := ch.Path
			st.row(c, rowSpec{
				label:   rel,
				meta:    ch.Status,
				metaClr: st.changeColor(ch.Status),
				onClick: func() { a.Dispatch(app.OpenDiff{Path: rel}) },
			})
		}
	})
}

// changeColor colors a git status letter.
func (s style) changeColor(status string) ui.Color {
	switch status {
	case "A":
		return s.success
	case "D":
		return s.danger
	case "?":
		return s.muted
	}
	return s.accent
}

// middleRow puts the editor beside the chat panel.
func middleRow(c *ui.Context, a *app.App, st style) {
	if !a.ChatOpen() {
		editorPane(c, a, st)
		return
	}
	ui.SplitPercent(c, &a.Layout.EditorCols,
		func() { editorPane(c, a, st) },
		func() { chatPanel(c, a, st) },
	).Fill()
}

func workspaceTitle(a *app.App, locale string) string {
	if name := a.WorkspaceName(); name != "" {
		return name
	}
	return i18n.T(locale, "statusNoWorkspace")
}
