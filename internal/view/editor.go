package view

import (
	"fmt"
	"runtime"
	"strings"

	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/i18n"
	"github.com/QinYangWang/omo/internal/kit"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/editor"
)

// editorPane shows the tab strip, the path of the open document and whatever the
// active tab wants: an editor, a diff review, or the session window, which is
// the strip's home tab.
func editorPane(c *ui.Context, a *app.App, st kit.Theme) {
	ui.Column(c).Fill().Background(st.BG).Children(func() {
		// No tabs, no tab strip: an empty one reads as a broken control.
		if len(a.Tabs()) > 0 {
			tabBar(c, a, st)
			st.HRule(c)
		}
		t := a.TabAt(a.Layout.ActiveTab)
		if t == nil {
			if a.WorkspaceName() != "" {
				sessionPane(c, a, st)
				return
			}
			welcome(c, a, st)
			return
		}
		crumbs(c, a, st)
		switch {
		case t.Kind == app.TabDiff:
			t.Diff.Theme = st.EditorTheme(c)
			diffPane(c, a, st, t)
		default:
			t.Editor.Theme = st.EditorTheme(c)
			editor.View(c, t.Editor).Grow(1)
		}
	})
}

// tabView is one tab of the strip: its label, icon and what clicking it does.
// A tab without onClose has no close box.
type tabView struct {
	label      string
	name       string // the accessible name when it differs from the label
	closeLabel string
	icon       *ui.SVG
	iconClr    ui.Color
	active     bool
	onClick    func()
	onClose    func()
}

// tabBar is a row of tabs, each with a file-type icon, its own close box and
// the editor's surface on the active one. The framework's Tabs widget cannot
// carry a close box per tab. The first tab is the session: it is the way home
// from any open document.
func tabBar(c *ui.Context, a *app.App, st kit.Theme) {
	loc := c.Locale()
	ui.Row(c).Height(st.TabH).PaddingX(6).Gap(2).AlignItems(ui.Center).Background(st.TabStrip()).Children(func() {
		tabEntry(c, st, tabView{
			label:   "omo",
			name:    i18n.T(loc, "tabSession"),
			icon:    kit.IconChat,
			active:  a.TabAt(a.Layout.ActiveTab) == nil,
			onClick: func() { a.Layout.ActiveTab = -1 },
		})
		for i, tab := range a.Tabs() {
			index := i
			label := tabTitle(a, tab, loc)
			icon, iconClr := tabIcon(st, tab)
			tabEntry(c, st, tabView{
				label:      label,
				closeLabel: i18n.Tf(loc, "tabClose", map[string]any{"name": label}),
				icon:       icon,
				iconClr:    iconClr,
				active:     i == a.Layout.ActiveTab,
				onClick:    func() { a.Layout.ActiveTab = index },
				onClose:    func() { a.Dispatch(app.CloseTab{Index: index}) },
			})
		}
		ui.Spacer(c)
		if t := a.TabAt(a.Layout.ActiveTab); t != nil && t.Kind == app.TabFile {
			st.IconChip(c, kit.IconGit, i18n.T(loc, "cmdReviewFile"), false, func() { a.Run(app.CmdReviewFile) })
		}
	})
}

// tabEntry draws one tab: its body, and its close box beside it.
func tabEntry(c *ui.Context, st kit.Theme, v tabView) {
	row := ui.Row(c).Height(st.TabH - 6).Radius(st.RadiusM).AlignItems(ui.Center).Focusable()
	row = row.Children(func() {
		body := ui.Row(c).Height(st.TabH - 6).PaddingX(8).Gap(6).AlignItems(ui.Center).Focusable()
		if v.name != "" {
			body = body.Label(v.name)
		}
		body = body.Children(func() {
			ui.Icon(c, v.icon).FontSize(13).TextColor(v.iconClr)
			t := ui.Text(c, v.label).FontSize(st.FontUI).SingleLine()
			if v.active {
				t = t.TextColor(st.Text).Bold()
			} else {
				t = t.TextColor(st.Muted)
			}
		})
		body.OnClick(v.onClick)

		if v.onClose == nil {
			return
		}
		// The close box is a sibling of the tab body, not a child: a nested
		// click target inside a clickable parent does not receive the click.
		x := ui.Box(c).Size(18, st.TabH-12).Radius(st.RadiusS).Justify(ui.Center).AlignItems(ui.Center).Focusable().
			Label(v.closeLabel)
		x = x.Children(func() {
			ui.Text(c, "×").FontSize(st.FontUI).TextColor(st.Muted)
		})
		if x.Hovered() {
			x.Background(st.Surface)
		}
		x.OnClick(v.onClose)
	})
	switch {
	case v.active:
		row.Background(st.ActiveTab()).Border(1, st.Border)
	case row.Hovered():
		row.Background(st.Hover)
	}
}

// crumbs is the path of the active document, as the reference editor shows it:
// the folder, then the file.
func crumbs(c *ui.Context, a *app.App, st kit.Theme) {
	t := a.TabAt(a.Layout.ActiveTab)
	if t == nil {
		return
	}
	parts := strings.Split(t.Rel, "/")
	ui.Row(c).Height(st.RowH).PaddingX(st.Pad).Gap(4).AlignItems(ui.Center).Children(func() {
		if t.Kind == app.TabDiff {
			ui.Text(c, i18n.T(c.Locale(), "sectionChanges")).FontSize(st.FontMeta).TextColor(st.Faint)
			ui.Icon(c, kit.IconChevronRight).FontSize(10).TextColor(st.Faint)
		}
		for i, part := range parts {
			if i > 0 {
				ui.Icon(c, kit.IconChevronRight).FontSize(10).TextColor(st.Faint)
			}
			col := st.Faint
			if i == len(parts)-1 {
				col = st.Muted
			}
			ui.Text(c, part).FontSize(st.FontMeta).TextColor(col).SingleLine()
		}
	})
}

// tabIcon is a tab's file-type icon, or the diff mark for a review.
func tabIcon(st kit.Theme, tab app.Tab) (*ui.SVG, ui.Color) {
	if tab.Kind == app.TabDiff {
		return kit.IconDiff, st.Accent
	}
	return st.FileIcon(baseName(tab.Rel))
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
func diffPane(c *ui.Context, a *app.App, st kit.Theme, t *app.Tab) {
	loc := c.Locale()
	added, deleted := t.Diff.Stats()
	ui.Row(c).Height(st.TabH).PaddingX(st.Pad).Gap(st.Gap+2).AlignItems(ui.Center).Background(st.Panel).
		BorderWidth(0, 0, 1, 0).BorderColor(st.Border).Children(func() {
		ui.Icon(c, kit.IconDiff).FontSize(14).TextColor(st.Accent)
		ui.Text(c, i18n.Tf(loc, "tabDiffTitle", map[string]any{"path": t.Rel})).FontSize(st.FontUI).TextColor(st.Text)
		ui.Text(c, fmt.Sprintf("+%d", added)).FontSize(st.FontMeta).TextColor(st.Success)
		ui.Text(c, fmt.Sprintf("−%d", deleted)).FontSize(st.FontMeta).TextColor(st.Danger)
		ui.Text(c, i18n.T(loc, "reviewHint")).FontSize(st.FontMeta).TextColor(st.Muted)
		ui.Spacer(c)
		if ui.PrimaryButton(c, i18n.T(loc, "diffApply")).Clicked() {
			a.Dispatch(app.ApplyReview{})
		}
	})
	editor.DiffView(c, t.Diff).Grow(1)
}

// welcome is the empty editor: the app's mark, what it is, and the first things
// to do, as rows with their keys.
func welcome(c *ui.Context, a *app.App, st kit.Theme) {
	loc := c.Locale()
	ui.Column(c).Fill().Center().Padding(32).Children(func() {
		ui.Column(c).Width(400).MaxWidthPercent(100).Gap(28).Children(func() {
			ui.Row(c).Gap(14).AlignItems(ui.Center).Children(func() {
				ui.Icon(c, kit.IconLogo).FontSize(44).TextColor(st.Accent)
				ui.Column(c).Gap(2).Children(func() {
					ui.Text(c, "omo").FontSize(26).Bold().LetterSpacing(-0.3).TextColor(st.Text)
					ui.Text(c, i18n.T(loc, "appTagline")).FontSize(st.FontUI).TextColor(st.Muted)
				})
			})
			ui.Column(c).Gap(2).Children(func() {
				ui.Text(c, i18n.T(loc, "welcomeStart")).FontSize(st.FontMeta).TextColor(st.Muted).
					Padding(0, 8, 4)
				st.ActionRow(c, kit.IconFolderOpen, i18n.T(loc, "cmdOpenFolder"), openFolderKeys(), func() {
					a.Run(app.CmdOpenFolder)
				})
				st.ActionRow(c, kit.IconTerminal, i18n.T(loc, "cmdNewTerminal"), newTerminalKeys(), func() {
					a.Run(app.CmdNewTerminal)
				})
			})
			ui.Text(c, i18n.T(loc, "welcomeHint")).FontSize(st.FontMeta).TextColor(st.Faint).PaddingX(8)
		})
	})
}

// openFolderKeys and newTerminalKeys name the menu's accelerators as the
// platform writes them.
func openFolderKeys() string {
	if runtime.GOOS == "darwin" {
		return "⌘⇧O"
	}
	return "Ctrl+Shift+O"
}

func newTerminalKeys() string {
	if runtime.GOOS == "darwin" {
		return "⌘⇧T"
	}
	return "Ctrl+Shift+T"
}

// conflictDialog asks what to do when a file changed on disk while the buffer
// had unsaved text. It never chooses for the user.
func conflictDialog(c *ui.Context, a *app.App, st kit.Theme) {
	if !a.ConflictOpen() {
		return
	}
	loc := c.Locale()
	open := true
	ui.Modal(c, &open, func() {
		ui.Column(c).Width(400).MaxWidthPercent(90).Gap(12).Padding(20).Radius(st.RadiusL).
			Background(st.Surface).Border(1, st.Border).Children(func() {
			ui.Text(c, i18n.T(loc, "conflictTitle")).FontSize(st.FontUI).Bold().TextColor(st.Text)
			ui.Text(c, i18n.Tf(loc, "conflictMessage", map[string]any{"path": a.ConflictPath()})).
				FontSize(st.FontMeta).TextColor(st.Muted)
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
