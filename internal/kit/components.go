package kit

import (
	"strings"

	"github.com/egoist/mygo/ui"
)

// HRule draws a 1 DIP horizontal rule. It fills the width only: Fill would make
// it as tall as the parent and paint over everything below it.
func (t Theme) HRule(c *ui.Context) {
	ui.Box(c).Height(1).FillWidth().Background(t.Border)
}

// VRule draws a 1 DIP vertical rule, the boundary between side-by-side panels.
func (t Theme) VRule(c *ui.Context) {
	ui.Box(c).Width(1).FillHeight().Background(t.Border)
}

// Mono is text in Geist Mono: code, paths, commands, numbers and key names.
func (t Theme) Mono(c *ui.Context, s string, size float32, col ui.Color) ui.Element {
	return ui.Text(c, s).Font(FontMono).FontSize(size).TextColor(col)
}

// Label is one line of interface text that never wraps.
func (t Theme) Label(c *ui.Context, s string, size float32, col ui.Color) ui.Element {
	return ui.Text(c, s).FontSize(size).TextColor(col).SingleLine()
}

// Tone is the meaning of a tag or a status dot. Color is state, never taste.
type Tone int

const (
	ToneNeutral Tone = iota
	ToneOK
	ToneWarn // waiting for the user's approval, nothing else
	ToneErr
	ToneAccent // in progress, current
	ToneOff    // not started: a ring
)

func (t Theme) toneColors(tone Tone) (fg, bg ui.Color) {
	switch tone {
	case ToneOK:
		return t.OK, t.OKBg
	case ToneWarn:
		return t.Warn, t.WarnBg
	case ToneErr:
		return t.Err, t.ErrBg
	case ToneAccent:
		return t.Accent, t.AccentBg
	}
	return t.Text2, t.Hover
}

// Tag is a 20 DIP state label: 已完成, 等待批准, 未连接, 新文件.
func (t Theme) Tag(c *ui.Context, icon *ui.SVG, label string, tone Tone) {
	fg, bg := t.toneColors(tone)
	ui.Row(c).Height(20).PaddingX(7).Gap(5).Radius(5).AlignItems(ui.Center).Background(bg).Shrink(0).Children(func() {
		if icon != nil {
			ui.Icon(c, icon).FontSize(12).TextColor(fg)
		}
		ui.Text(c, label).FontSize(t.FontMeta).FontWeight(500).TextColor(fg).SingleLine()
	})
}

// Dot is a 7 DIP status dot; ToneOff draws a ring for "not started".
func (t Theme) Dot(c *ui.Context, tone Tone) {
	d := ui.Box(c).Size(7, 7).Radius(3.5).Shrink(0)
	if tone == ToneOff {
		d.Border(1.5, t.Text3)
		return
	}
	fg, _ := t.toneColors(tone)
	d.Background(fg)
}

// Keys draws key caps: Ctrl, Shift, Enter, written out as Windows and Linux
// write them.
func (t Theme) Keys(c *ui.Context, keys ...string) {
	ui.Row(c).Gap(3).AlignItems(ui.Center).Shrink(0).Children(func() {
		for _, k := range keys {
			ui.Box(c).Height(18).MinWidth(18).PaddingX(4).Radius(t.RadiusTag).Border(1, t.Border2).
				Justify(ui.Center).AlignItems(ui.Center).Children(func() {
				t.Mono(c, k, t.FontMeta, t.Text2).SingleLine()
			})
		}
	})
}

// KeyHint is a shortcut written as plain mono text, as the sidebar's
// "Ctrl+N".
func (t Theme) KeyHint(c *ui.Context, keys string) {
	t.Mono(c, keys, t.FontMeta, t.Text3).SingleLine()
}

// ButtonKind is the weight of a button.
type ButtonKind int

const (
	// ButtonDefault is outlined on the surface.
	ButtonDefault ButtonKind = iota
	// ButtonPrimary is the accent fill: one per view.
	ButtonPrimary
	// ButtonGhost has no box until hovered.
	ButtonGhost
)

// Button describes a text button with an optional icon and key cap.
type Button struct {
	Label string
	Icon  *ui.SVG
	Kind  ButtonKind
	Small bool   // 26 DIP instead of 30
	Key   string // a key cap after the label, as "Enter"
	Tip   string
	// Width fixes the width; zero sizes to the content.
	Width float32
}

// Btn draws a button and calls onClick when it is pressed.
func (t Theme) Btn(c *ui.Context, b Button, onClick func()) {
	h, px, fs := t.CtlH, float32(12), t.FontRow
	if b.Small {
		h, px, fs = 26, 9, t.FontSmall
	}
	e := ui.Row(c).Height(h).PaddingX(px).Gap(7).Radius(7).Justify(ui.Center).AlignItems(ui.Center).
		Focusable().Label(b.Label).Shrink(0)
	if b.Width > 0 {
		e = e.Width(b.Width)
	}
	if b.Tip != "" {
		e = e.Tooltip(b.Tip)
	}
	fg := t.Text
	switch b.Kind {
	case ButtonPrimary:
		fg = t.OnAccent
		bg := t.Accent
		if e.Hovered() {
			bg = t.Accent.Mix(contrastTint(t.Dark), 0.10)
		}
		e = e.Background(bg).Border(1, bg)
	case ButtonGhost:
		fg = t.Text2
		if e.Hovered() {
			e = e.Background(t.Hover)
			fg = t.Text
		}
	default:
		bg := t.Surface
		if e.Hovered() {
			bg = t.Hover
		}
		e = e.Background(bg).Border(1, t.Border2)
	}
	e.Children(func() {
		if b.Icon != nil {
			ui.Icon(c, b.Icon).FontSize(14).TextColor(fg)
		}
		ui.Text(c, b.Label).FontSize(fs).FontWeight(500).TextColor(fg).SingleLine()
		if b.Key != "" {
			border := t.Border2
			if b.Kind == ButtonPrimary {
				border = t.OnAccent.Alpha(0.35)
			}
			ui.Box(c).Height(16).MinWidth(16).PaddingX(4).Radius(t.RadiusTag).Border(1, border).
				Justify(ui.Center).AlignItems(ui.Center).Children(func() {
				t.Mono(c, b.Key, 10, fg).SingleLine()
			})
		}
	})
	if onClick != nil {
		e.OnClick(onClick)
	}
}

// IconButton is a 28 DIP square icon button; its label is the tooltip and the
// accessible name.
func (t Theme) IconButton(c *ui.Context, icon *ui.SVG, label string, active bool, onClick func()) {
	e := ui.Box(c).Size(28, 28).Radius(t.RadiusS).Justify(ui.Center).AlignItems(ui.Center).Focusable().
		Label(label).Tooltip(label).Shrink(0)
	col := t.Text3
	switch {
	case active:
		e.Background(t.Hover)
		col = t.Text
	case e.Hovered():
		e.Background(t.Hover)
		col = t.Text2
	}
	e.Children(func() { ui.Icon(c, icon).FontSize(15).TextColor(col) })
	if onClick != nil {
		e.OnClick(onClick)
	}
}

// TitleButton is a title bar button: icon and short label, as 计划 and the
// change counts.
func (t Theme) TitleButton(c *ui.Context, icon *ui.SVG, label string, active bool, content func(), onClick func()) {
	e := ui.Row(c).Height(28).PaddingX(9).Gap(6).Radius(t.RadiusS).AlignItems(ui.Center).Focusable().
		Label(label).Tooltip(label).Shrink(0)
	col := t.Text2
	if active || e.Hovered() {
		e.Background(t.Hover)
		col = t.Text
	}
	e.Children(func() {
		ui.Icon(c, icon).FontSize(14).TextColor(col)
		if content != nil {
			content()
		} else {
			ui.Text(c, label).FontSize(t.FontSmall).TextColor(col).SingleLine()
		}
	})
	if onClick != nil {
		e.OnClick(onClick)
	}
}

// Chip is a 24 DIP outlined chip on the surface: the agent of a session, the
// workspace and the branch of the new-session screen.
func (t Theme) Chip(c *ui.Context, label string, content func(), onClick func()) {
	e := ui.Row(c).Height(24).PaddingX(8).Gap(6).Radius(t.RadiusS).AlignItems(ui.Center).
		Background(t.Surface).Border(1, t.Border).Shrink(0)
	if onClick != nil {
		e = e.Focusable().Label(label)
		if e.Hovered() {
			e = e.Background(t.Hover)
		}
		e.OnClick(onClick)
	}
	e.Children(content)
}

// NavItem is a 30 DIP navigation row: the sidebar's actions and the settings
// pages.
func (t Theme) NavItem(c *ui.Context, icon *ui.SVG, label, keys string, active bool, onClick func()) {
	e := ui.Row(c).Height(t.RowH).PaddingX(8).Gap(10).Radius(t.RadiusS).AlignItems(ui.Center).
		Focusable().Label(label)
	col := t.Text2
	switch {
	case active:
		e.Background(t.Selected)
		col = t.Text
	case e.Hovered():
		e.Background(t.Hover)
		col = t.Text
	}
	e.Children(func() {
		ui.Icon(c, icon).FontSize(15).TextColor(col)
		ui.Text(c, label).FontSize(t.FontUI).TextColor(col).SingleLine()
		ui.Spacer(c)
		if keys != "" {
			t.KeyHint(c, keys)
		}
	})
	if onClick != nil {
		e.OnClick(onClick)
	}
}

// Section is a group label: 11 DIP, medium, the note color, sentence case, with
// optional actions at its right.
func (t Theme) Section(c *ui.Context, title string, actions func()) {
	ui.Row(c).Height(28).Padding(10, 10, 2, 16).Gap(6).AlignItems(ui.Center).Children(func() {
		ui.Text(c, title).FontSize(t.FontMeta).FontWeight(500).TextColor(t.Text3).SingleLine()
		ui.Spacer(c)
		if actions != nil {
			actions()
		}
	})
}

// SmallIconButton is a 20 DIP icon button for section actions (+, settings).
func (t Theme) SmallIconButton(c *ui.Context, icon *ui.SVG, label string, onClick func()) {
	e := ui.Box(c).Size(20, 20).Radius(5).Justify(ui.Center).AlignItems(ui.Center).Focusable().
		Label(label).Tooltip(label)
	col := t.Text3
	if e.Hovered() {
		e.Background(t.Hover)
		col = t.Text
	}
	e.Children(func() { ui.Icon(c, icon).FontSize(13).TextColor(col) })
	if onClick != nil {
		e.OnClick(onClick)
	}
}

// Seg is a segmented control drawn in the system's look: a well of Side, the
// chosen segment lifted onto Surface with a Border2 ring.
func (t Theme) Seg(c *ui.Context, selected *int, labels ...string) bool {
	changed := false
	ui.Row(c).Padding(2).Gap(2).Radius(7).Background(t.Side).Border(1, t.Border).AlignItems(ui.Center).Shrink(0).
		AlignSelf(ui.Start).
		Children(func() {
			for i, label := range labels {
				i := i
				e := ui.Row(c).Height(22).PaddingX(9).Radius(5).AlignItems(ui.Center).Focusable().Label(label)
				col := t.Text2
				if i == *selected {
					e = e.Background(t.Surface).Border(1, t.Border2)
					col = t.Text
				} else if e.Hovered() {
					col = t.Text
				}
				e.Children(func() { ui.Text(c, label).FontSize(t.FontSmall).TextColor(col).SingleLine() })
				e.OnClick(func() {
					if *selected != i {
						*selected = i
						changed = true
					}
				})
			}
		})
	return changed
}

// Switch is the 32×18 on/off switch bound to *on.
func (t Theme) Switch(c *ui.Context, on *bool, label string) {
	t.Toggle(c, *on, label, func() { *on = !*on })
}

// Toggle draws the switch for a value the caller owns: Border2 when off, the
// accent when on; onClick flips it.
func (t Theme) Toggle(c *ui.Context, on bool, label string, onClick func()) {
	bg := t.Border2
	if on {
		bg = t.Accent
	}
	e := ui.Box(c).Size(32, 18).Radius(9).Background(bg).Focusable().Label(label).Shrink(0)
	e.Children(func() {
		x := float32(2)
		if on {
			x = 16
		}
		ui.Box(c).Absolute().Left(x).Top(2).Size(14, 14).Radius(7).Background(ui.Hex("#FFFFFF"))
	})
	if onClick != nil {
		e.OnClick(onClick)
	}
}

// SelectBox shows the chosen option with a chevron; a click moves to the next
// option, so the control is real without a popup.
func (t Theme) SelectBox(c *ui.Context, label string, selected *int, options []string) {
	if len(options) == 0 {
		return
	}
	if *selected < 0 || *selected >= len(options) {
		*selected = 0
	}
	e := ui.Row(c).Height(30).PaddingX(10).Gap(8).Radius(7).Background(t.BG).Border(1, t.Border2).
		AlignItems(ui.Center).Focusable().Label(label).Tooltip(label).Shrink(0)
	if e.Hovered() {
		e = e.Background(t.Hover)
	}
	e.Children(func() {
		ui.Text(c, options[*selected]).FontSize(t.FontRow).TextColor(t.Text).SingleLine()
		ui.Icon(c, IconChevronDown).FontSize(13).TextColor(t.Text3)
	})
	e.OnClick(func() { *selected = (*selected + 1) % len(options) })
}

// Card is a bordered group on the surface: settings groups, tool cards.
func (t Theme) Card(c *ui.Context, fn func()) ui.Element {
	return ui.Column(c).FillWidth().Radius(t.RadiusM).Background(t.Surface).Border(1, t.Border).Clip().Children(fn)
}

// SettingsCard is a card of setting rows with a rule between each.
func (t Theme) SettingsCard(c *ui.Context, rows ...func()) {
	t.Card(c, func() {
		for i, row := range rows {
			if i > 0 {
				t.HRule(c)
			}
			row()
		}
	})
}

// SettingRow is one row of a settings card: a title, an optional description
// and a control at the right.
func (t Theme) SettingRow(c *ui.Context, title, desc string, control func()) {
	ui.Row(c).MinHeight(50).Padding(10, 16).Gap(14).AlignItems(ui.Center).FillWidth().Children(func() {
		ui.Column(c).Grow(1).Gap(1).Children(func() {
			ui.Text(c, title).FontSize(t.FontUI).TextColor(t.Text)
			if desc != "" {
				ui.Text(c, desc).FontSize(t.FontSmall).TextColor(t.Text3)
			}
		})
		if control != nil {
			control()
		}
	})
}

// Bar is a 4 DIP progress bar: a plan's progress, the context window.
func (t Theme) Bar(c *ui.Context, frac float32, width float32, col ui.Color) {
	if frac < 0 {
		frac = 0
	}
	if frac > 1 {
		frac = 1
	}
	ui.Box(c).Size(width, 4).Radius(2).Background(t.Hover).Clip().Shrink(0).Children(func() {
		if frac > 0 {
			ui.Box(c).Size(width*frac, 4).Radius(2).Background(col)
		}
	})
}

// Avatar is the user's initial on the accent.
func (t Theme) Avatar(c *ui.Context, name string, size float32) {
	initial := "?"
	for _, r := range strings.TrimSpace(name) {
		initial = strings.ToUpper(string(r))
		break
	}
	ui.Box(c).Size(size, size).Radius(t.RadiusS).Background(t.Accent).Justify(ui.Center).AlignItems(ui.Center).
		Shrink(0).Children(func() {
		ui.Text(c, initial).FontSize(size * 0.48).FontWeight(600).TextColor(t.OnAccent)
	})
}

// AgentMark is the mark of an ACP agent. omo ships no third-party logos: an
// agent is its initial on a quiet tile, and Pi its own Lucide glyph on an
// inverted tile, as the design draws it.
func (t Theme) AgentMark(c *ui.Context, name string, size float32) {
	lower := strings.ToLower(strings.TrimSpace(name))
	if lower == "pi" || strings.HasPrefix(lower, "pi ") {
		ui.Box(c).Size(size, size).Radius(4).Background(t.Text).Justify(ui.Center).AlignItems(ui.Center).
			Shrink(0).Children(func() {
			ui.Icon(c, IconPi).FontSize(size * 0.72).TextColor(t.BG)
		})
		return
	}
	initial := "?"
	for _, r := range strings.TrimSpace(name) {
		initial = strings.ToUpper(string(r))
		break
	}
	ui.Box(c).Size(size, size).Radius(4).Background(t.Hover).Border(1, t.Border2).Justify(ui.Center).
		AlignItems(ui.Center).Shrink(0).Children(func() {
		ui.Text(c, initial).Font(FontMono).FontSize(size * 0.56).FontWeight(600).TextColor(t.Text)
	})
}

// Popover styles the panel of a floating layer: Raised, a Border2 line, the
// 12 DIP radius and the system's one shadow.
func (t Theme) Popover(e ui.Element) ui.Element {
	return e.Background(t.Raised).Border(1, t.Border2).Radius(t.RadiusL).Shadow(0, 10, 28, 0, t.Shadow).Clip()
}

// EmptyState is a view with nothing to show: an icon over one or two lines.
func (t Theme) EmptyState(c *ui.Context, icon *ui.SVG, title, text string) {
	ui.Column(c).FillWidth().Padding(32, 16).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Icon(c, icon).FontSize(22).TextColor(t.Text3)
		if title != "" {
			ui.Text(c, title).FontSize(t.FontUI).FontWeight(500).TextColor(t.Text)
		}
		if text != "" {
			ui.Text(c, text).FontSize(t.FontSmall).TextColor(t.Text3)
		}
	})
}

// RowSpec describes one list row: the file tree, the change list.
type RowSpec struct {
	Indent  float32
	Arrow   *ui.SVG // a disclosure chevron, before the icon
	Icon    *ui.SVG
	IconClr ui.Color // zero keeps the quiet color
	Label   string
	Mono    bool
	Meta    string
	MetaClr ui.Color
	Badge   string // a status letter at the far right
	Active  bool
	Tip     string
	OnClick func()
}

// Row draws one list row, 28 DIP, with hover and selection.
func (t Theme) Row(c *ui.Context, r RowSpec) {
	e := ui.Row(c).Height(28).PaddingX(8).Gap(8).Radius(t.RadiusS).AlignItems(ui.Center).Focusable().Label(r.Label)
	if r.Tip != "" {
		e = e.Tooltip(r.Tip)
	}
	switch {
	case r.Active:
		e = e.Background(t.Selected)
	case e.Hovered():
		e = e.Background(t.Hover)
	}
	e.Children(func() {
		if r.Indent > 0 {
			ui.Box(c).Width(r.Indent).Height(1)
		}
		if r.Arrow != nil {
			ui.Icon(c, r.Arrow).FontSize(12).TextColor(t.Text3)
		}
		if r.Icon != nil {
			col := r.IconClr
			if col.A == 0 {
				col = t.Text3
			}
			ui.Icon(c, r.Icon).FontSize(14).TextColor(col)
		}
		if r.Mono {
			t.Mono(c, r.Label, t.FontSmall, t.Text).SingleLine()
		} else {
			ui.Text(c, r.Label).FontSize(t.FontRow).TextColor(t.Text).SingleLine()
		}
		ui.Spacer(c)
		if r.Meta != "" {
			col := r.MetaClr
			if col.A == 0 {
				col = t.Text3
			}
			t.Mono(c, r.Meta, 11.5, col).SingleLine()
		}
		if r.Badge != "" {
			ui.Box(c).Width(14).Children(func() {
				t.Mono(c, r.Badge, t.FontMeta, t.StatusColor(r.Badge)).SingleLine()
			})
		}
	})
	if r.OnClick != nil {
		e.OnClick(r.OnClick)
	}
}

// DiffLine is one line of a diff block.
type DiffLine struct {
	Num  int    // zero leaves the number column blank
	Sign string // "+", "-" or " "
	Text string
}

// DiffBlock draws lines in the code well: a 38 DIP number column, a sign
// column, and added/deleted rows on their tint.
func (t Theme) DiffBlock(c *ui.Context, lines []DiffLine) {
	ui.Column(c).FillWidth().Radius(7).Background(t.Code).Border(1, t.Border).Clip().PaddingY(4).Children(func() {
		for _, l := range lines {
			fg := t.Text2
			var bg ui.Color
			switch l.Sign {
			case "+":
				fg, bg = t.OK, t.AddBg
			case "-":
				fg, bg = t.Err, t.DelBg
			}
			row := ui.Row(c).FillWidth().Height(20).AlignItems(ui.Center)
			if bg.A > 0 {
				row = row.Background(bg)
			}
			row.Children(func() {
				num := ""
				if l.Num > 0 {
					num = itoa(l.Num)
				}
				ui.Row(c).Width(38).PaddingX(10).Justify(ui.End).Children(func() {
					t.Mono(c, num, 11.5, t.Text3).SingleLine()
				})
				ui.Box(c).Width(16).Children(func() {
					t.Mono(c, l.Sign, 11.5, fg).SingleLine()
				})
				t.Mono(c, l.Text, 11.5, fg).SingleLine()
			})
		}
	})
}

// CodeWell draws preformatted lines (terminal output, process output) in the
// code well. A line starting with "$ " is the command and reads quieter.
func (t Theme) CodeWell(c *ui.Context, lines []string, errLine func(string) bool) {
	ui.Column(c).FillWidth().Radius(7).Background(t.Code).Border(1, t.Border).Padding(9, 12).Gap(2).Children(func() {
		for _, l := range lines {
			col := t.Text2
			switch {
			case strings.HasPrefix(l, "$ "):
				col = t.Text3
			case errLine != nil && errLine(l):
				col = t.Err
			}
			t.Mono(c, l, 11.5, col)
		}
	})
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
