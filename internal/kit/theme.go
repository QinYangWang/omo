// Package kit is omo's design system: the colors, type sizes and spacing the
// window draws with, and the components every panel is built from.
//
// It is the same idea as shadcn/ui, in immediate mode: a Theme holds design
// tokens, components are functions that take a *ui.Context and read the tokens
// from the Theme, and the look changes in one file (this one) rather than in
// every panel. Use it instead of drawing with bare ui primitives and literal
// colors; docs/kit.md shows the components and how to add one.
package kit

import (
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/editor"
)

// palette is the look the chrome shares with the code: near-black surfaces,
// one violet accent, and syntax colors that agree with it, in a dark window and
// in a light one.
type palette struct {
	dark bool

	bg    ui.Color // the editor and the terminal
	panel ui.Color // the header, the sidebars and the status bar
	// surface is the face of buttons and inputs, surfaceHover and
	// surfacePressed while hovered or pressed.
	surface, surfaceHover, surfacePressed ui.Color
	border                                ui.Color

	text  ui.Color
	muted ui.Color
	faint ui.Color

	accent     ui.Color // marks, icons and the focus ring
	accentText ui.Color
	fill       ui.Color // the accent under a button's label
	fillText   ui.Color

	hover    ui.Color // a row under the pointer
	selected ui.Color // a chosen row

	success ui.Color
	danger  ui.Color
	warning ui.Color

	line      ui.Color // the caret's line, in the editor
	guide     ui.Color // indent guides
	gutter    ui.Color // line numbers
	selection ui.Color // selected text
	scrollbar ui.Color

	tokens map[editor.TokenKind]ui.Color
}

func paletteFor(dark bool) palette {
	if dark {
		return darkPalette()
	}
	return lightPalette()
}

func darkPalette() palette {
	p := palette{
		dark:           true,
		bg:             ui.Hex("#18181d"),
		panel:          ui.Hex("#131317"),
		surface:        ui.Hex("#202027"),
		surfaceHover:   ui.Hex("#272730"),
		surfacePressed: ui.Hex("#2e2e38"),
		border:         ui.Hex("#26262e"),
		text:           ui.Hex("#d6d6de"),
		muted:          ui.Hex("#8c8c99"),
		faint:          ui.Hex("#666672"),
		accent:         ui.Hex("#8b7cf6"),
		accentText:     ui.Hex("#ffffff"),
		fill:           ui.Hex("#7260e3"),
		fillText:       ui.Hex("#ffffff"),
		hover:          ui.RGBA(255, 255, 255, 0.045),
		selected:       ui.RGBA(139, 124, 246, 0.16),
		success:        ui.Hex("#6ec98d"),
		danger:         ui.Hex("#f0718b"),
		warning:        ui.Hex("#e8b86d"),
		line:           ui.RGBA(255, 255, 255, 0.035),
		guide:          ui.RGBA(255, 255, 255, 0.065),
		gutter:         ui.Hex("#62626e"),
		selection:      ui.RGBA(139, 124, 246, 0.30),
		scrollbar:      ui.RGBA(255, 255, 255, 0.16),
	}
	p.setTokens("#b99cf7", "#7dcfe0", "#8fb4ff", "#a9d48f", "#f2a679",
		"#747481", "#a0a5b8", "#8a8e9e", "#f590a8", "#e8c482",
		"#b99cf7", "#8fb4ff", "#8fb4ff", "#a9d48f")
	return p
}

func lightPalette() palette {
	p := palette{
		dark:           false,
		bg:             ui.Hex("#fcfcfd"),
		panel:          ui.Hex("#f4f4f7"),
		surface:        ui.Hex("#ffffff"),
		surfaceHover:   ui.Hex("#f2f2f6"),
		surfacePressed: ui.Hex("#eaeaf0"),
		border:         ui.Hex("#e4e4ea"),
		text:           ui.Hex("#2a2a33"),
		muted:          ui.Hex("#6c6c79"),
		faint:          ui.Hex("#8e8e9a"),
		accent:         ui.Hex("#6d5bd0"),
		accentText:     ui.Hex("#ffffff"),
		fill:           ui.Hex("#6d5bd0"),
		fillText:       ui.Hex("#ffffff"),
		hover:          ui.RGBA(0, 0, 0, 0.04),
		selected:       ui.RGBA(109, 91, 208, 0.12),
		success:        ui.Hex("#2f8a53"),
		danger:         ui.Hex("#d0365a"),
		warning:        ui.Hex("#c4862a"),
		line:           ui.RGBA(0, 0, 0, 0.03),
		guide:          ui.RGBA(0, 0, 0, 0.07),
		gutter:         ui.Hex("#93939f"),
		selection:      ui.RGBA(109, 91, 208, 0.20),
		scrollbar:      ui.RGBA(0, 0, 0, 0.18),
	}
	p.setTokens("#7c3bd6", "#0b7c99", "#2a5bd7", "#3d8a28", "#c2571a",
		"#868692", "#555a6b", "#6c6f80", "#c8264f", "#a86a0c",
		"#7c3bd6", "#2a5bd7", "#2a5bd7", "#3d8a28")
	return p
}

// setTokens maps the code colors of the editor onto the palette, so code reads
// in the same key as the chrome.
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
		editor.TokenInserted:    p.success,
		editor.TokenDeleted:     p.danger,
		editor.TokenInvalid:     p.danger,
	}
}

// Theme holds the design tokens: surfaces, text colors, type sizes and spacing
// in one place, so every panel agrees. Panels read the tokens and draw with the
// components of this package; nothing outside this package hardcodes a color.
type Theme struct {
	Dark bool

	// BG is the editor's and the terminal's background; Panel is the chrome's:
	// the header, the sidebars, the status bar.
	BG    ui.Color
	Panel ui.Color
	// Surface is the face of controls, SurfaceHover and SurfacePressed while
	// hovered or pressed; Border is every 1 DIP rule.
	Surface, SurfaceHover, SurfacePressed ui.Color
	Border                                ui.Color

	Text  ui.Color
	Muted ui.Color
	Faint ui.Color

	Accent     ui.Color // marks, icons and the focus ring
	AccentText ui.Color
	Fill       ui.Color // the accent under a button's label
	FillText   ui.Color

	Hover    ui.Color // a row under the pointer
	Selected ui.Color // a chosen row

	Success ui.Color
	Danger  ui.Color
	Warning ui.Color

	Line      ui.Color // the caret's line, in the editor
	Guide     ui.Color // indent guides
	Gutter    ui.Color // line numbers
	Selection ui.Color // selected text

	Tokens map[editor.TokenKind]ui.Color

	// Type sizes in DIPs: meta text, interface text, list rows.
	FontMeta float32
	FontUI   float32
	FontList float32

	// Row and bar heights.
	RowH   float32
	TabH   float32
	TitleH float32
	BarH   float32
	HeadH  float32

	Pad float32
	Gap float32
	// LeftW and RightW are the widths of the sessions panel and the right
	// sidebar.
	LeftW  float32
	RightW float32
}

// New derives the palette from the window's appearance, hands it to the widgets
// as their theme, and returns the tokens panels draw with. Widgets therefore
// follow the same colors: buttons, scroll bars, the editor and the terminal.
func New(c *ui.Context) Theme { return newTheme(c) }

func newTheme(c *ui.Context) Theme {
	t := *c.Theme()
	p := paletteFor(t.Dark)

	t.Dark = p.dark
	t.Background = p.bg
	t.Surface = p.surface
	t.SurfaceHover = p.surfaceHover
	t.SurfacePressed = p.surfacePressed
	t.Border = p.border
	t.Text = p.text
	t.TextMuted = p.muted
	t.Accent = p.fill
	t.AccentText = p.fillText
	t.AccentHover = p.fill.Mix(ui.Hex("#ffffff"), 0.12)
	t.AccentPressed = p.fill.Mix(ui.Hex("#000000"), 0.16)
	t.Danger = p.danger
	t.Warning = p.warning
	t.Success = p.success
	t.Selection = p.selection
	t.Focus = p.accent.Alpha(0.55)
	t.Scrollbar = p.scrollbar
	t.ScrollbarWidth = 8
	t.Radius = 6
	t.Spacing = 4
	t.FontSize = 13
	c.SetTheme(&t)

	return Theme{
		Dark:         p.dark,
		BG:           p.bg,
		Panel:        p.panel,
		Surface:      p.surface,
		SurfaceHover: p.surfaceHover, SurfacePressed: p.surfacePressed,
		Border:     p.border,
		Text:       p.text,
		Muted:      p.muted,
		Faint:      p.faint,
		Accent:     p.accent,
		AccentText: p.accentText,
		Fill:       p.fill,
		FillText:   p.fillText,
		Success:    p.success,
		Danger:     p.danger,
		Warning:    p.warning,
		Hover:      p.hover,
		Selected:   p.selected,
		Line:       p.line,
		Guide:      p.guide,
		Gutter:     p.gutter,
		Selection:  p.selection,
		Tokens:     p.tokens,

		FontMeta: 11,
		FontUI:   12.5,
		FontList: 12.5,

		RowH:   24,
		TabH:   34,
		TitleH: 30,
		BarH:   26,
		HeadH:  38,

		Pad:    10,
		Gap:    6,
		LeftW:  260,
		RightW: 280,
	}
}

// EditorTheme colors the editor and the diffs with the palette, so the code
// sits in the same window as the chrome rather than in a theme of its own.
func (t Theme) EditorTheme(c *ui.Context) *editor.Theme {
	th := editor.DefaultTheme(c.Theme())
	th.Background = t.BG
	th.Text = t.Text
	th.LineNumber = t.Gutter
	th.ActiveLineNumber = t.Text
	th.ActiveLine = t.Line
	th.Selection = t.Selection
	th.InactiveSelection = t.Selection.Alpha(0.55)
	th.Cursor = t.Accent
	th.MatchingBracket = t.Faint
	th.Match = t.Warning.Alpha(0.22)
	th.CurrentMatch = t.Warning.Alpha(0.42)
	th.Occurrence = t.Selected
	th.IndentGuide = t.Guide
	th.ActiveIndentGuide = t.Guide.Alpha(2.2)
	th.WrapGuide = t.Guide
	th.Whitespace = t.Faint.Alpha(0.55)
	th.Added, th.Deleted, th.Modified = t.Success, t.Danger, t.Accent
	for kind, color := range t.Tokens {
		th.Tokens[kind].Color = color
	}
	return th
}

// Lang picks a language's color for the current appearance, as file icons and
// git marks do.
func (t Theme) Lang(dark, light string) ui.Color {
	if t.Dark {
		return ui.Hex(dark)
	}
	return ui.Hex(light)
}
