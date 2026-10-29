package view

import (
	"github.com/egoist/mygo/ui"
)

// rowSpec describes one list row. Rows are the building block of the file tree,
// the changes list, the activity rail and the terminal tabs.
type rowSpec struct {
	indent  float32
	icon    *ui.SVG
	dot     bool // marker for unsaved text
	label   string
	meta    string
	metaClr ui.Color
	active  bool // selection or open tab
	onClick func()
}

// row draws one 22 DIP row with 13 DIP text, hover and selection backgrounds and
// an optional marker at the right. The caller supplies the click action.
func (s style) row(c *ui.Context, r rowSpec) {
	e := ui.Row(c).Height(s.rowH).PaddingX(s.gap).Gap(s.gap).AlignItems(ui.Center).Focusable()
	e = e.Children(func() {
		if r.indent > 0 {
			ui.Box(c).Width(r.indent).Height(1)
		}
		if r.icon != nil {
			ui.Icon(c, r.icon).TextColor(s.iconColor(r.active))
		}
		if r.dot {
			ui.Text(c, "●").FontSize(s.fsMeta * 0.7).TextColor(s.accent)
		}
		t := ui.Text(c, r.label).FontSize(s.fsList).TextColor(s.text)
		if r.active {
			t = t.Bold()
		}
		ui.Spacer(c)
		if r.meta != "" {
			ui.Text(c, r.meta).FontSize(s.fsMeta).TextColor(r.metaClr)
		}
	})
	switch {
	case r.active:
		e.Background(s.selected)
	case e.Hovered():
		e.Background(s.hover)
	}
	if r.onClick != nil {
		e.OnClick(r.onClick)
	}
}

// iconColor keeps icons muted until their row is active.
func (s style) iconColor(active bool) ui.Color {
	if active {
		return s.accent
	}
	return s.muted
}

// chip is a small clickable label, used where a full button would be too heavy:
// the terminal tabs and the chat footer.
func (s style) chip(c *ui.Context, label string, active bool, onClick func()) {
	e := ui.Row(c).Height(s.rowH).PaddingX(s.gap + 2).AlignItems(ui.Center).Focusable()
	e = e.Children(func() {
		t := ui.Text(c, label).FontSize(s.fsUI).TextColor(s.text)
		if active {
			t.Bold()
		}
	})
	switch {
	case active:
		e.Background(s.selected)
	case e.Hovered():
		e.Background(s.hover)
	}
	if onClick != nil {
		e.OnClick(onClick)
	}
}
