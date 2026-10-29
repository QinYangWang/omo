package view

import "github.com/egoist/mygo/ui"

// style holds the view's design tokens: surfaces, text colors, type sizes and
// spacing in one place, so every panel agrees.
//
// Surfaces come from the window theme, so the app follows the system's light or
// dark appearance and matches the editor and the terminal, which draw from the
// same theme. The editor keeps the window background; the side panels, the chat
// and the bottom panel take the theme's surface, which gives the window its
// layers without inventing colors.
type style struct {
	dark bool

	bg         ui.Color
	panel      ui.Color
	header     ui.Color
	border     ui.Color
	text       ui.Color
	muted      ui.Color
	accent     ui.Color
	accentText ui.Color
	success    ui.Color
	danger     ui.Color
	hover      ui.Color
	selected   ui.Color

	// Type sizes in DIPs: meta text, interface text, list rows.
	fsMeta float32
	fsUI   float32
	fsList float32

	// Row and bar heights.
	rowH   float32
	tabH   float32
	titleH float32
	barH   float32

	pad   float32
	gap   float32
	railW float32
	sideW float32
}

func newStyle(c *ui.Context) style {
	t := c.Theme()
	return style{
		dark:       t.Dark,
		bg:         t.Background, // the editor surface
		panel:      t.Surface,    // side panels, chat and the bottom panel
		header:     t.Surface,    // tab strip and status bar
		border:     t.Border,
		text:       t.Text,
		muted:      t.TextMuted,
		accent:     t.Accent,
		accentText: t.AccentText,
		success:    t.Success,
		danger:     t.Danger,
		hover:      t.SurfaceHover,
		selected:   t.SurfacePressed,

		fsMeta: 11,
		fsUI:   12,
		fsList: 13,

		rowH:   22,
		tabH:   32,
		titleH: 26,
		barH:   24,

		pad:   10,
		gap:   6,
		railW: 44,
		sideW: 240,
	}
}

// hrule draws a 1 DIP horizontal rule, the boundary between stacked panels.
// It fills the width only: Fill would make it as tall as the parent and paint
// over everything below it.
func (s style) hrule(c *ui.Context) {
	ui.Box(c).Height(1).FillWidth().Background(s.border)
}

// vrule draws a 1 DIP vertical rule, the boundary between side-by-side panels.
func (s style) vrule(c *ui.Context) {
	ui.Box(c).Width(1).FillHeight().Background(s.border)
}

// tabStrip and activeTab pick the tab strip's and the open tab's surfaces: the
// open tab stands out of the strip in both appearances, which means the lighter
// surface in dark mode and the lighter one in light mode too, from the opposite
// side of the pair.
func (s style) tabStrip() ui.Color {
	if s.dark {
		return s.bg
	}
	return s.panel
}

func (s style) activeTab() ui.Color {
	if s.dark {
		return s.panel
	}
	return s.bg
}

// sectionTitle is the small caps-ish header of a side panel section. It is not
// clickable: the caller decides whether it collapses its content.
func (s style) sectionTitle(c *ui.Context, title string) {
	ui.Text(c, title).FontSize(s.fsMeta).TextColor(s.muted).PaddingX(s.pad)
}
