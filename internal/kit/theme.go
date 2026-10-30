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

// palette is the look the chrome shares with the code: neutral surfaces, one
// blue for focus and marks, contrast for primary actions, and syntax colors that
// agree with it, in a dark window and in a light one.
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

// The palette comes from Vercel's Geist scale, which the design rules in
// DESIGN.md follow: neutral grays for every surface, one blue for focus and
// marks, the strength of a primary button from contrast (white on black in the
// dark window, black on white in the light one), and green/amber/red only for
// state. The hex values are the oklch tokens of vercel-brand.css converted to
// sRGB (gray 100/200/300, gray 900/1000, blue 700/900, green 900, amber 900,
// red 700); the alpha borders are its gray-alpha tokens.
func darkPalette() palette {
	p := palette{
		dark:           true,
		bg:             ui.Hex("#0a0a0a"), // raised surface: the code and the session
		panel:          ui.Hex("#000000"), // the chrome: header, sidebars, status bar
		surface:        ui.Hex("#1a1a1a"),
		surfaceHover:   ui.Hex("#1f1f1f"),
		surfacePressed: ui.Hex("#292929"),
		border:         ui.RGBA(255, 255, 255, 0.12),
		text:           ui.Hex("#ededed"),
		muted:          ui.Hex("#a0a0a0"),
		faint:          ui.Hex("#7a7a7a"),
		accent:         ui.Hex("#47a8ff"), // focus, active marks, links
		accentText:     ui.Hex("#000000"),
		fill:           ui.Hex("#ededed"), // primary button: light on dark
		fillText:       ui.Hex("#000000"),
		hover:          ui.RGBA(255, 255, 255, 0.06),
		selected:       ui.RGBA(255, 255, 255, 0.10),
		success:        ui.Hex("#00ca50"),
		danger:         ui.Hex("#f13242"),
		warning:        ui.Hex("#ff9300"),
		line:           ui.RGBA(255, 255, 255, 0.035),
		guide:          ui.RGBA(255, 255, 255, 0.08),
		gutter:         ui.Hex("#878787"),
		selection:      ui.RGBA(255, 255, 255, 0.14),
		scrollbar:      ui.RGBA(255, 255, 255, 0.16),
	}
	p.setTokens("#47a8ff", "#00ca50", "#ededed", "#00ca50", "#ff9300",
		"#7a7a7a", "#a0a0a0", "#878787", "#f13242", "#ff9300",
		"#a0a0a0", "#ededed", "#47a8ff", "#00ca50")
	return p
}

func lightPalette() palette {
	p := palette{
		dark:           false,
		bg:             ui.Hex("#ffffff"), // the code and the session
		panel:          ui.Hex("#fafafa"), // the chrome
		surface:        ui.Hex("#ffffff"),
		surfaceHover:   ui.Hex("#f2f2f2"),
		surfacePressed: ui.Hex("#e6e6e6"),
		border:         ui.RGBA(0, 0, 0, 0.10),
		text:           ui.Hex("#171717"),
		muted:          ui.Hex("#4d4d4d"),
		faint:          ui.Hex("#737373"),
		accent:         ui.Hex("#006bff"), // focus, active marks, links
		accentText:     ui.Hex("#ffffff"),
		fill:           ui.Hex("#171717"), // primary button: dark on light
		fillText:       ui.Hex("#ffffff"),
		hover:          ui.RGBA(0, 0, 0, 0.04),
		selected:       ui.RGBA(0, 0, 0, 0.06),
		success:        ui.Hex("#107d32"),
		danger:         ui.Hex("#d1002b"),
		warning:        ui.Hex("#aa4d00"),
		line:           ui.RGBA(0, 0, 0, 0.03),
		guide:          ui.RGBA(0, 0, 0, 0.07),
		gutter:         ui.Hex("#9a9a9a"),
		selection:      ui.RGBA(0, 0, 0, 0.10),
		scrollbar:      ui.RGBA(0, 0, 0, 0.18),
	}
	p.setTokens("#006bff", "#107d32", "#171717", "#107d32", "#aa4d00",
		"#8f8f8f", "#4d4d4d", "#707070", "#d1002b", "#aa4d00",
		"#4d4d4d", "#171717", "#006bff", "#107d32")
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
	// RadiusS, RadiusM and RadiusL are the only corner radii: 4 for small
	// inner boxes, 6 for controls and rows, 10 for dialogs.
	RadiusS float32
	RadiusM float32
	RadiusL float32
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
	// The plan is contrast, not hue: a light button in the dark window and a
	// dark one in the light window, so PrimaryButton keeps its weight in either.
	t.Accent = p.fill
	t.AccentText = p.fillText
	t.AccentHover = p.fill.Mix(contrastTint(p.dark), 0.12)
	t.AccentPressed = p.fill.Mix(contrastTint(p.dark), 0.20)
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

		Pad:     10,
		Gap:     6,
		RadiusS: 4,
		RadiusM: 6,
		RadiusL: 10,
		LeftW:   260,
		RightW:  280,
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
