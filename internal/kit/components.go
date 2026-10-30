package kit

import (
	"github.com/egoist/mygo/ui"
)

// HRule draws a 1 DIP horizontal rule, the boundary between stacked panels. It
// fills the width only: Fill would make it as tall as the parent and paint over
// everything below it.
func (t Theme) HRule(c *ui.Context) {
	ui.Box(c).Height(1).FillWidth().Background(t.Border)
}

// VRule draws a 1 DIP vertical rule, the boundary between side-by-side panels.
func (t Theme) VRule(c *ui.Context) {
	ui.Box(c).Width(1).FillHeight().Background(t.Border)
}

// TabStrip is the surface of a tab strip; ActiveTab the surface of the open tab,
// which takes the editor's color and so rises out of the strip in both
// appearances.
func (t Theme) TabStrip() ui.Color { return t.Panel }

func (t Theme) ActiveTab() ui.Color { return t.BG }

// RowSpec describes one list row. Rows are the building block of the file tree,
// the changes list, the sessions panel and every other list.
type RowSpec struct {
	Indent  float32
	Arrow   *ui.SVG // a disclosure chevron, before the icon
	Icon    *ui.SVG
	IconClr ui.Color // zero keeps the icon's quiet color
	Dot     bool     // marker for unsaved text
	Label   string
	Meta    string
	MetaClr ui.Color
	Active  bool // selection or open tab
	Tip     string
	OnClick func()
}

// Row draws one row with the list text, hover and selection backgrounds, an
// optional icon and a marker at the right. The caller supplies the click action.
func (t Theme) Row(c *ui.Context, r RowSpec) {
	e := ui.Row(c).Height(t.RowH).PaddingX(6).Gap(6).AlignItems(ui.Center).Focusable()
	if r.Tip != "" {
		e = e.Tooltip(r.Tip)
	}
	e = e.Children(func() {
		if r.Indent > 0 {
			ui.Box(c).Width(r.Indent).Height(1)
		}
		if r.Arrow != nil {
			ui.Icon(c, r.Arrow).FontSize(12).TextColor(t.Faint)
		}
		if r.Icon != nil {
			col := r.IconClr
			if col.A == 0 {
				col = t.IconColor(r.Active)
			}
			ui.Icon(c, r.Icon).FontSize(14).TextColor(col)
		}
		label := ui.Text(c, r.Label).FontSize(t.FontList).TextColor(t.Text).SingleLine()
		if r.Active {
			label = label.Bold()
		}
		ui.Spacer(c)
		if r.Dot {
			ui.Text(c, "●").FontSize(t.FontMeta * 0.7).TextColor(t.Accent)
		}
		if r.Meta != "" {
			ui.Text(c, r.Meta).FontSize(t.FontMeta).TextColor(r.MetaClr)
		}
	})
	switch {
	case r.Active:
		e.Background(t.Selected)
	case e.Hovered():
		e.Background(t.Hover)
	}
	if r.OnClick != nil {
		e.OnClick(r.OnClick)
	}
}

// IconColor keeps icons muted until their row is active.
func (t Theme) IconColor(active bool) ui.Color {
	if active {
		return t.Accent
	}
	return t.Muted
}

// SectionLabel is a small section name in a panel: sentence case, one quiet
// color, no tracking. Hierarchy comes from the rows under it, not from caps.
func (t Theme) SectionLabel(c *ui.Context, title string) {
	ui.Text(c, title).FontSize(t.FontMeta).TextColor(t.Muted)
}

// SectionRow is SectionLabel in a row of its own, above the rows it names.
func (t Theme) SectionRow(c *ui.Context, title string) {
	ui.Row(c).Height(t.RowH).PaddingX(t.Pad).AlignItems(ui.Center).Children(func() {
		t.SectionLabel(c, title)
	})
}

// SectionHeader is a collapsible section label with a chevron and a folder icon,
// as the file tree's root has.
func (t Theme) SectionHeader(c *ui.Context, title string, open *bool) {
	e := ui.Row(c).Height(t.RowH + 4).PaddingX(6).Gap(6).AlignItems(ui.Center).Focusable()
	e = e.Children(func() {
		icon := IconChevronRight
		if *open {
			icon = IconChevronDown
		}
		ui.Icon(c, icon).FontSize(12).TextColor(t.Faint)
		ui.Icon(c, IconFolderOpen).FontSize(14).TextColor(t.Muted)
		ui.Text(c, title).FontSize(t.FontList).TextColor(t.Text).SingleLine()
	})
	if e.Hovered() {
		e.Background(t.Hover)
	}
	e.OnClick(func() { *open = !*open })
}

// Chip is a small clickable label, used where a full button would be too heavy:
// the status bar's toggles and the terminal's pages.
func (t Theme) Chip(c *ui.Context, label string, active bool, onClick func()) {
	e := ui.Row(c).Height(t.RowH).PaddingX(t.Gap + 2).Radius(t.RadiusM).AlignItems(ui.Center).Focusable()
	e = e.Children(func() {
		text := ui.Text(c, label).FontSize(t.FontUI)
		switch {
		case active:
			text = text.TextColor(t.Accent).Bold()
		default:
			text = text.TextColor(t.Muted)
		}
	})
	if active {
		e.Background(t.Selected)
	} else if e.Hovered() {
		e.Background(t.Hover)
	}
	if onClick != nil {
		e.OnClick(onClick)
	}
}

// IconChip is a Chip with a leading icon.
func (t Theme) IconChip(c *ui.Context, icon *ui.SVG, label string, active bool, onClick func()) {
	e := ui.Row(c).Height(t.RowH).PaddingX(t.Gap + 2).Radius(t.RadiusM).Gap(t.Gap).AlignItems(ui.Center).Focusable()
	e = e.Children(func() {
		col := t.Muted
		if active {
			col = t.Accent
		}
		ui.Icon(c, icon).FontSize(13).TextColor(col)
		text := ui.Text(c, label).FontSize(t.FontUI)
		if active {
			text = text.TextColor(t.Text).Bold()
		} else {
			text = text.TextColor(t.Muted)
		}
	})
	if active {
		e.Background(t.Selected)
	} else if e.Hovered() {
		e.Background(t.Hover)
	}
	if onClick != nil {
		e.OnClick(onClick)
	}
}

// IconButton is a square button showing an icon in the chrome, its label in a
// tooltip and in the accessibility tree.
func (t Theme) IconButton(c *ui.Context, icon *ui.SVG, label string, active bool, onClick func()) {
	e := ui.Box(c).Size(26, 24).Radius(t.RadiusM).Justify(ui.Center).AlignItems(ui.Center).Focusable().
		Label(label).Tooltip(label)
	col := t.Muted
	switch {
	case active:
		e.Background(t.Selected)
		col = t.Accent
	case e.Hovered():
		e.Background(t.Hover)
		col = t.Text
	}
	e = e.Children(func() {
		ui.Icon(c, icon).FontSize(15).TextColor(col)
	})
	if onClick != nil {
		e.OnClick(onClick)
	}
}

// ActionRow is a wide row with an accent icon at the left and a label, a row of
// the welcome screen, the session window and the run page.
func (t Theme) ActionRow(c *ui.Context, icon *ui.SVG, label, meta string, onClick func()) {
	e := ui.Row(c).Height(t.RowH + 6).PaddingX(8).Radius(t.RadiusM).Gap(8).AlignItems(ui.Center).Focusable()
	e = e.Children(func() {
		ui.Icon(c, icon).FontSize(15).TextColor(t.Accent)
		ui.Text(c, label).FontSize(t.FontUI).TextColor(t.Text).SingleLine()
		ui.Spacer(c)
		if meta != "" {
			ui.Text(c, meta).FontSize(t.FontMeta).TextColor(t.Faint)
		}
	})
	if e.Hovered() {
		e.Background(t.Hover)
	}
	if onClick != nil {
		e.OnClick(onClick)
	}
}

// IconTab is one tab of an icon strip: the pages of the right sidebar.
type IconTab struct {
	Icon  *ui.SVG
	Label string // the tooltip and the accessible name
	// Active marks the page shown. Tabs are drawn as a pill when active.
	Active  bool
	OnClick func()
}

// IconTabs is a strip of icon-only tabs in a panel's header, the chosen one
// marked with the accent and a pill.
func (t Theme) IconTabs(c *ui.Context, tabs []IconTab) {
	ui.Row(c).Height(t.TabH).PaddingX(6).Gap(2).AlignItems(ui.Center).Children(func() {
		for _, tab := range tabs {
			tab := tab
			e := ui.Box(c).Size(30, 26).Radius(t.RadiusM).Justify(ui.Center).AlignItems(ui.Center).
				Focusable().Label(tab.Label).Tooltip(tab.Label)
			col := t.Muted
			switch {
			case tab.Active:
				e.Background(t.Selected)
				col = t.Accent
			case e.Hovered():
				e.Background(t.Hover)
				col = t.Text
			}
			e = e.Children(func() {
				ui.Icon(c, tab.Icon).FontSize(16).TextColor(col)
			})
			if tab.OnClick != nil {
				e.OnClick(tab.OnClick)
			}
		}
		ui.Spacer(c)
	})
}

// EmptyState is a panel with nothing to show: an icon over one line of text.
func (t Theme) EmptyState(c *ui.Context, icon *ui.SVG, text string) {
	ui.Column(c).Fill().Padding(t.Pad).Gap(8).Children(func() {
		ui.Icon(c, icon).FontSize(22).TextColor(t.Faint)
		ui.Text(c, text).FontSize(t.FontMeta).TextColor(t.Muted)
	})
}
