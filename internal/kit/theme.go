// Package kit is omo's design system: the colors, type sizes and spacing the
// window draws with, and the components every panel is built from.
//
// It is the same idea as shadcn/ui, in immediate mode: a Theme holds design
// tokens, components are functions that take a *ui.Context and read the tokens
// from the Theme, and the look changes in one file (this one) rather than in
// every panel. Use it instead of drawing with bare ui primitives and literal
// colors; docs/kit.md shows the components and how to add one.
//
// The tokens are the Doop "omo-app-style" v2 system (DESIGN.md): a graphite
// drawing desk, warm off-white text like tracing paper, and one cobalt pen.
package kit

import (
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/editor"
)

// Font families. RegisterFonts adds Geist and Geist Mono (SIL OFL 1.1, the
// OFL.txt beside them) at start; Chinese falls back to the system's CJK face
// (Microsoft YaHei UI, PingFang SC, Noto Sans SC/CJK).
const (
	FontSans = "Geist"
	FontMono = "Geist Mono"
)

// Mode is the appearance the user chose in Settings → Appearance.
type Mode string

const (
	// ModeSystem follows the operating system's light or dark appearance.
	ModeSystem Mode = "system"
	ModeLight  Mode = "light"
	ModeDark   Mode = "dark"
)

// palette is one appearance of the system, named as the design's CSS variables
// are (--bg, --side, --surface …) so a reviewer can diff the two.
type palette struct {
	dark bool

	bg      ui.Color // the main area
	side    ui.Color // the sidebar, settings navigation, the well of a segmented control
	surface ui.Color // cards, inputs, tool cards
	raised  ui.Color // popovers and dialogs
	hover   ui.Color
	sel     ui.Color
	border  ui.Color // dividers
	border2 ui.Color // control outlines

	text, text2, text3 ui.Color

	accent, accentBg, onAccent ui.Color

	ok, okBg                   ui.Color
	warn, warnBg, warnLine     ui.Color
	err, errBg, errLine        ui.Color
	addBg, delBg               ui.Color
	code, scrim, shadow        ui.Color
	line, guide, gutter, selTx ui.Color
	scrollbar                  ui.Color

	tokens map[editor.TokenKind]ui.Color
}

func paletteFor(dark bool) palette {
	if dark {
		return darkPalette()
	}
	return lightPalette()
}

// darkPalette is the night drawing desk: graphite, warm off-white text, the
// cobalt accent lifted to #7C93FF so it holds against #131416.
func darkPalette() palette {
	p := palette{
		dark:      true,
		bg:        ui.Hex("#131416"),
		side:      ui.Hex("#0F1012"),
		surface:   ui.Hex("#18191C"),
		raised:    ui.Hex("#1D1E22"),
		hover:     ui.Hex("#222327"),
		sel:       ui.Hex("#26272C"),
		border:    ui.Hex("#26272B"),
		border2:   ui.Hex("#34353B"),
		text:      ui.Hex("#ECECE7"),
		text2:     ui.Hex("#A3A39D"),
		text3:     ui.Hex("#6D6D68"),
		accent:    ui.Hex("#7C93FF"),
		accentBg:  ui.RGBA(124, 147, 255, 0.13),
		onAccent:  ui.Hex("#0D0E14"),
		ok:        ui.Hex("#4CC38A"),
		okBg:      ui.RGBA(76, 195, 138, 0.12),
		warn:      ui.Hex("#E8B04A"),
		warnBg:    ui.RGBA(232, 176, 74, 0.10),
		warnLine:  ui.RGBA(232, 176, 74, 0.45),
		err:       ui.Hex("#F2726B"),
		errBg:     ui.RGBA(242, 114, 107, 0.10),
		errLine:   ui.RGBA(242, 114, 107, 0.40),
		addBg:     ui.RGBA(76, 195, 138, 0.10),
		delBg:     ui.RGBA(242, 114, 107, 0.10),
		code:      ui.Hex("#16171A"),
		scrim:     ui.RGBA(6, 7, 9, 0.62),
		shadow:    ui.RGBA(0, 0, 0, 0.45),
		line:      ui.RGBA(255, 255, 255, 0.03),
		guide:     ui.RGBA(255, 255, 255, 0.07),
		gutter:    ui.Hex("#6D6D68"),
		selTx:     ui.RGBA(124, 147, 255, 0.28),
		scrollbar: ui.RGBA(255, 255, 255, 0.14),
	}
	p.setTokens("#7C93FF", "#4CC38A", "#ECECE7", "#4CC38A", "#E8B04A",
		"#6D6D68", "#A3A39D", "#A3A39D", "#F2726B", "#E8B04A",
		"#A3A39D", "#ECECE7", "#7C93FF", "#4CC38A")
	return p
}

// lightPalette is the same desk by day: warm paper, ink-black text and a
// deeper cobalt that keeps its contrast on white.
func lightPalette() palette {
	p := palette{
		dark:      false,
		bg:        ui.Hex("#FBFBFA"),
		side:      ui.Hex("#F3F3F1"),
		surface:   ui.Hex("#FFFFFF"),
		raised:    ui.Hex("#FFFFFF"),
		hover:     ui.Hex("#ECECE9"),
		sel:       ui.Hex("#E6E6E2"),
		border:    ui.Hex("#E3E3DF"),
		border2:   ui.Hex("#D2D2CD"),
		text:      ui.Hex("#18181A"),
		text2:     ui.Hex("#5C5C58"),
		text3:     ui.Hex("#8D8D88"),
		accent:    ui.Hex("#3654D6"),
		accentBg:  ui.RGBA(54, 84, 214, 0.09),
		onAccent:  ui.Hex("#FFFFFF"),
		ok:        ui.Hex("#1E8A55"),
		okBg:      ui.RGBA(30, 138, 85, 0.10),
		warn:      ui.Hex("#9A6200"),
		warnBg:    ui.RGBA(214, 150, 30, 0.10),
		warnLine:  ui.RGBA(184, 124, 10, 0.45),
		err:       ui.Hex("#C8392F"),
		errBg:     ui.RGBA(200, 57, 47, 0.08),
		errLine:   ui.RGBA(200, 57, 47, 0.35),
		addBg:     ui.RGBA(30, 138, 85, 0.09),
		delBg:     ui.RGBA(200, 57, 47, 0.08),
		code:      ui.Hex("#F6F6F4"),
		scrim:     ui.RGBA(24, 24, 26, 0.32),
		shadow:    ui.RGBA(20, 20, 24, 0.12),
		line:      ui.RGBA(0, 0, 0, 0.03),
		guide:     ui.RGBA(0, 0, 0, 0.07),
		gutter:    ui.Hex("#8D8D88"),
		selTx:     ui.RGBA(54, 84, 214, 0.18),
		scrollbar: ui.RGBA(0, 0, 0, 0.18),
	}
	p.setTokens("#3654D6", "#1E8A55", "#18181A", "#1E8A55", "#9A6200",
		"#8D8D88", "#5C5C58", "#5C5C58", "#C8392F", "#9A6200",
		"#5C5C58", "#18181A", "#3654D6", "#1E8A55")
	return p
}

// setTokens maps the code colors of the editor onto the palette, so code reads
// in the same key as the chrome: no hue outside the system's five.
func (p *palette) setTokens(keyword, typ, function, str, number, comment, operator, punctuation, tag, attribute, meta, heading, link, code string) {
	p.tokens = map[editor.TokenKind]ui.Color{
		editor.TokenText:        p.text,
		editor.TokenKeyword:     ui.Hex(keyword),
		editor.TokenType:        ui.Hex(typ),
		editor.TokenFunction:    ui.Hex(function),
		editor.TokenVariable:    p.text,
		editor.TokenProperty:    ui.Hex(typ),
		editor.TokenConstant:    ui.Hex(number),
		editor.TokenNumber:      ui.Hex(number),
		editor.TokenString:      ui.Hex(str),
		editor.TokenEscape:      ui.Hex(number),
		editor.TokenRegexp:      ui.Hex(str),
		editor.TokenComment:     ui.Hex(comment),
		editor.TokenOperator:    ui.Hex(operator),
		editor.TokenPunctuation: ui.Hex(punctuation),
		editor.TokenTag:         ui.Hex(tag),
		editor.TokenAttribute:   ui.Hex(attribute),
		editor.TokenMeta:        ui.Hex(meta),
		editor.TokenHeading:     ui.Hex(heading),
		editor.TokenLink:        ui.Hex(link),
		editor.TokenCode:        ui.Hex(code),
		editor.TokenInserted:    p.ok,
		editor.TokenDeleted:     p.err,
		editor.TokenInvalid:     p.err,
	}
}

// Theme holds the design tokens: surfaces, text colors, type sizes and spacing
// in one place, so every panel agrees. Panels read the tokens and draw with the
// components of this package; nothing outside this package hardcodes a color.
type Theme struct {
	Dark bool

	// BG is the main area; Side the sidebar, the settings navigation and the
	// well of a segmented control; Surface cards, inputs and tool cards;
	// Raised popovers and dialogs.
	BG, Side, Surface, Raised ui.Color
	// Hover and Selected are a row under the pointer and a chosen row.
	Hover, Selected ui.Color
	// Border divides; Border2 outlines controls.
	Border, Border2 ui.Color

	// Text, Text2 and Text3: body, secondary, notes.
	Text, Text2, Text3 ui.Color

	// Accent is the one accent: the primary button, what is in progress, the
	// focus and checked switches. AccentBg tints a current row; OnAccent is
	// text on the accent.
	Accent, AccentBg, OnAccent ui.Color

	// OK, Warn and Err are state only (and diff counts); Warn is reserved for
	// "waiting for your approval".
	OK, OKBg               ui.Color
	Warn, WarnBg, WarnLine ui.Color
	Err, ErrBg, ErrLine    ui.Color
	AddBg, DelBg           ui.Color

	// Code is the well of terminals and code blocks; Scrim dims the window
	// under a dialog (flat, no blur); Shadow is the one shadow, popovers only.
	Code, Scrim, Shadow ui.Color

	// Editor colors.
	Line, Guide, Gutter, Selection ui.Color
	Tokens                         map[editor.TokenKind]ui.Color

	// Aliases kept for the editor and older components.
	Panel, Muted, Faint, Success, Danger, Warning ui.Color

	// Type sizes in DIPs.
	FontMeta    float32 // 11: section labels, key caps, side notes
	FontSmall   float32 // 12: chips, descriptions, mono paths
	FontUI      float32 // 13: body
	FontRow     float32 // 12.5: rows, buttons, tool cards
	FontTitle   float32 // 13.5: the session title
	FontH1      float32 // 20: a settings page
	FontDisplay float32 // 30: the new-session question

	// Heights.
	RowH  float32 // 30: navigation and list rows
	HeadH float32 // 48: the title bar of the main area and the sidebar top
	CtlH  float32 // 30: buttons and selects
	BarH  float32 // 34: the line under the composer

	// Spacing: Pad inside a panel, Gap between controls of a group.
	Pad, Gap float32

	// RadiusS controls (6), RadiusM cards (10), RadiusL inputs, popovers and
	// dialogs (12). RadiusTag is the 4 DIP of key caps and inline code.
	RadiusTag, RadiusS, RadiusM, RadiusL float32

	// Widths of the fixed columns.
	SideW, InspectorW, PanelW, SettingsNavW, ColumnW float32
}

// New derives the theme from the window's appearance.
func New(c *ui.Context) Theme { return NewFor(c, ModeSystem) }

// NewFor derives the theme for the appearance the user chose, hands it to the
// widgets as their theme and returns the tokens panels draw with. Widgets
// therefore follow the same colors: buttons, scroll bars, the editor and the
// terminal.
func NewFor(c *ui.Context, mode Mode) Theme {
	t := *c.Theme()
	dark := t.Dark
	switch mode {
	case ModeDark:
		dark = true
	case ModeLight:
		dark = false
	}
	p := paletteFor(dark)

	t.Dark = p.dark
	t.Background = p.bg
	t.Surface = p.surface
	t.SurfaceHover = p.hover
	t.SurfacePressed = p.sel
	t.Border = p.border2
	t.Text = p.text
	t.TextMuted = p.text3
	t.Accent = p.accent
	t.AccentText = p.onAccent
	t.AccentHover = p.accent.Mix(contrastTint(p.dark), 0.10)
	t.AccentPressed = p.accent.Mix(contrastTint(p.dark), 0.18)
	t.Danger = p.err
	t.Warning = p.warn
	t.Success = p.ok
	t.Selection = p.selTx
	t.Focus = p.accent.Alpha(0.55)
	t.Inverse = p.text
	t.InverseText = p.bg
	t.Scrollbar = p.scrollbar
	t.ScrollbarWidth = 8
	t.Radius = 7
	t.Spacing = 4
	t.FontSize = 13
	t.Font = FontSans
	c.SetTheme(&t)

	return Theme{
		Dark: p.dark,
		BG:   p.bg, Side: p.side, Surface: p.surface, Raised: p.raised,
		Hover: p.hover, Selected: p.sel,
		Border: p.border, Border2: p.border2,
		Text: p.text, Text2: p.text2, Text3: p.text3,
		Accent: p.accent, AccentBg: p.accentBg, OnAccent: p.onAccent,
		OK: p.ok, OKBg: p.okBg,
		Warn: p.warn, WarnBg: p.warnBg, WarnLine: p.warnLine,
		Err: p.err, ErrBg: p.errBg, ErrLine: p.errLine,
		AddBg: p.addBg, DelBg: p.delBg,
		Code: p.code, Scrim: p.scrim, Shadow: p.shadow,
		Line: p.line, Guide: p.guide, Gutter: p.gutter, Selection: p.selTx,
		Tokens: p.tokens,

		Panel: p.side, Muted: p.text2, Faint: p.text3,
		Success: p.ok, Danger: p.err, Warning: p.warn,

		FontMeta:    11,
		FontSmall:   12,
		FontUI:      13,
		FontRow:     12.5,
		FontTitle:   13.5,
		FontH1:      20,
		FontDisplay: 30,

		RowH:  30,
		HeadH: 48,
		CtlH:  30,
		BarH:  34,

		Pad: 16,
		Gap: 8,

		RadiusTag: 4,
		RadiusS:   6,
		RadiusM:   10,
		RadiusL:   12,

		SideW:        252,
		InspectorW:   300,
		PanelW:       520,
		SettingsNavW: 236,
		ColumnW:      720,
	}
}

// contrastTint is the direction a primary button moves while hovered: away from
// its own value, into the background it sits on.
func contrastTint(dark bool) ui.Color {
	if dark {
		return ui.Hex("#000000")
	}
	return ui.Hex("#ffffff")
}

// EditorTheme colors the editor and the diffs with the palette, so the code
// sits in the same window as the chrome rather than in a theme of its own.
func (t Theme) EditorTheme(c *ui.Context) *editor.Theme {
	th := editor.DefaultTheme(c.Theme())
	th.Background = t.Code
	th.Text = t.Text2
	th.LineNumber = t.Gutter
	th.ActiveLineNumber = t.Text
	th.ActiveLine = t.Line
	th.Selection = t.Selection
	th.InactiveSelection = t.Selection.Alpha(0.55)
	th.Cursor = t.Accent
	th.MatchingBracket = t.Faint
	th.Match = t.Warn.Alpha(0.22)
	th.CurrentMatch = t.Warn.Alpha(0.42)
	th.Occurrence = t.Hover
	th.IndentGuide = t.Guide
	th.ActiveIndentGuide = t.Guide.Alpha(2.2)
	th.WrapGuide = t.Guide
	th.Whitespace = t.Faint.Alpha(0.55)
	th.Added, th.Deleted, th.Modified = t.OK, t.Err, t.Accent
	for kind, color := range t.Tokens {
		th.Tokens[kind].Color = color
	}
	return th
}

// Lang picks a language's color for the current appearance, as file icons do.
func (t Theme) Lang(dark, light string) ui.Color {
	if t.Dark {
		return ui.Hex(dark)
	}
	return ui.Hex(light)
}
