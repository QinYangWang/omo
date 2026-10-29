package view

import (
	"fmt"

	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/i18n"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/editor"
)

// editorPane shows the tab strip and whatever the active tab wants: an editor, a
// diff review, or the welcome screen when nothing is open.
func editorPane(c *ui.Context, a *app.App, st style) {
	ui.Column(c).Fill().Background(st.bg).Children(func() {
		if len(a.Tabs()) == 0 {
			// No tabs, no tab strip: an empty one reads as a broken control.
			welcome(c, a, st)
			return
		}
		tabBar(c, a, st)
		st.hrule(c)
		t := a.TabAt(a.Layout.ActiveTab)
		switch {
		case t == nil:
		case t.Kind == app.TabDiff:
			diffPane(c, a, st, t)
		default:
			editor.View(c, t.Editor).Grow(1)
		}
	})
}

// tabBar is a row of tabs, each with its own close box and an accent underline on
// the active one. The framework's Tabs widget cannot carry a close box per tab.
func tabBar(c *ui.Context, a *app.App, st style) {
	loc := c.Locale()
	ui.Row(c).Height(st.tabH).PaddingX(4).Gap(2).AlignItems(ui.Center).Background(st.tabStrip()).Children(func() {
		for i, tab := range a.Tabs() {
			index := i
			active := i == a.Layout.ActiveTab
			label := tabTitle(a, tab, loc)
			underline := st.tabStrip()
			if active {
				underline = st.accent
			}

			col := ui.Column(c).Focusable()
			col = col.Children(func() {
				ui.Row(c).Grow(1).PaddingX(8).Gap(8).AlignItems(ui.Center).Children(func() {
					ui.Text(c, label).FontSize(st.fsUI).TextColor(st.text)
				})
				ui.Box(c).Height(2).FillWidth().Background(underline)
			})
			switch {
			case active:
				col.Background(st.activeTab())
			case col.Hovered():
				col.Background(st.hover)
			}
			col.OnClick(func() { a.Layout.ActiveTab = index })

			// The close box is a sibling of the tab, not a child: a nested
			// click target inside a clickable parent does not receive the click.
			x := ui.Box(c).Width(18).Height(st.tabH - 8).Justify(ui.Center).AlignItems(ui.Center).Focusable()
			x = x.Children(func() {
				ui.Text(c, "×").FontSize(st.fsUI).TextColor(st.muted)
			})
			if x.Hovered() {
				x.Background(st.selected)
			}
			x.OnClick(func() { a.Dispatch(app.CloseTab{Index: index}) })
		}
		ui.Spacer(c)
		if t := a.TabAt(a.Layout.ActiveTab); t != nil && t.Kind == app.TabFile {
			st.chip(c, i18n.T(loc, "cmdReviewFile"), false, func() { a.Run(app.CmdReviewFile) })
		}
	})
}

// tabTitle is a tab's label. A diff tab is marked with a sign instead of the
// words "Diff:", which the pane's own header already says.
func tabTitle(a *app.App, tab app.Tab, locale string) string {
	if tab.Kind == app.TabDiff {
		return "± " + baseName(tab.Rel)
	}
	return baseName(tab.Rel)
}

// diffPane is a review: a compact header with the change counts and the apply
// action, then the viewer, whose Revert/Keep actions edit the new side.
func diffPane(c *ui.Context, a *app.App, st style, t *app.Tab) {
	loc := c.Locale()
	added, deleted := t.Diff.Stats()
	ui.Row(c).Height(st.tabH).PaddingX(st.pad).Gap(st.gap + 2).AlignItems(ui.Center).Background(st.header).Children(func() {
		ui.Text(c, i18n.Tf(loc, "tabDiffTitle", map[string]any{"path": t.Rel})).FontSize(st.fsUI).TextColor(st.text)
		ui.Text(c, fmt.Sprintf("+%d", added)).FontSize(st.fsMeta).TextColor(st.success)
		ui.Text(c, fmt.Sprintf("−%d", deleted)).FontSize(st.fsMeta).TextColor(st.danger)
		ui.Text(c, i18n.T(loc, "reviewHint")).FontSize(st.fsMeta).TextColor(st.muted)
		ui.Spacer(c)
		if ui.PrimaryButton(c, i18n.T(loc, "diffApply")).Clicked() {
			a.Dispatch(app.ApplyReview{})
		}
	})
	st.hrule(c)
	editor.DiffView(c, t.Diff).Grow(1)
}

func welcome(c *ui.Context, a *app.App, st style) {
	loc := c.Locale()
	ui.Column(c).Fill().Center().Gap(8).Padding(32).Children(func() {
		ui.Text(c, "omo").FontSize(20).Bold().TextColor(st.text)
		ui.Text(c, i18n.T(loc, "appTagline")).FontSize(st.fsUI).TextColor(st.muted)
		ui.Text(c, i18n.T(loc, "welcomeHint")).FontSize(st.fsMeta).TextColor(st.muted)
		ui.Box(c).Height(6)
		if ui.PrimaryButton(c, i18n.T(loc, "welcomeOpenFolder")).Clicked() {
			a.Run(app.CmdOpenFolder)
		}
	})
}

// conflictDialog asks what to do when a file changed on disk while the buffer
// had unsaved text. It never chooses for the user.
func conflictDialog(c *ui.Context, a *app.App, st style) {
	if !a.ConflictOpen() {
		return
	}
	loc := c.Locale()
	open := true
	ui.Modal(c, &open, func() {
		ui.Column(c).Gap(10).Padding(20).Background(st.header).Children(func() {
			ui.Text(c, i18n.T(loc, "conflictTitle")).FontSize(st.fsUI).Bold().TextColor(st.text)
			ui.Text(c, i18n.Tf(loc, "conflictMessage", map[string]any{"path": a.ConflictPath()})).
				FontSize(st.fsMeta).TextColor(st.muted)
			ui.Row(c).Gap(8).Children(func() {
				if ui.PrimaryButton(c, i18n.T(loc, "conflictReload")).Clicked() {
					a.Dispatch(app.ResolveConflict{Choice: app.ConflictReload})
				}
				if ui.Button(c, i18n.T(loc, "conflictOverwrite")).Clicked() {
					a.Dispatch(app.ResolveConflict{Choice: app.ConflictOverwrite})
				}
				if ui.Button(c, i18n.T(loc, "conflictCancel")).Clicked() {
					a.Dispatch(app.ResolveConflict{Choice: app.ConflictCancel})
				}
			})
		})
	})
	if !open {
		a.Dispatch(app.ResolveConflict{Choice: app.ConflictCancel})
	}
}

// baseName is the last element of a slash or backslash path.
func baseName(rel string) string {
	for i := len(rel) - 1; i >= 0; i-- {
		if rel[i] == '/' || rel[i] == '\\' {
			return rel[i+1:]
		}
	}
	return rel
}
