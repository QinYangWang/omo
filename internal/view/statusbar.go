package view

import (
	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/i18n"
	"github.com/QinYangWang/omo/internal/kit"
	"github.com/egoist/mygo/ui"
)

// statusBar mirrors the reference design: repository state on the left, the
// caret and file facts on the right, with panel toggles at the end.
func statusBar(c *ui.Context, a *app.App, st kit.Theme) {
	loc := c.Locale()

	branch := a.Branch()
	if branch == "" {
		branch = i18n.T(loc, "statusNoRepo")
	}

	ui.Row(c).Height(st.BarH).PaddingX(st.Gap).Gap(st.Gap + 1).AlignItems(ui.Center).Background(st.Panel).Children(func() {
		ui.Icon(c, kit.IconGit).FontSize(12).TextColor(st.Muted)
		ui.Text(c, branch).FontSize(st.FontMeta).TextColor(st.Muted).SingleLine()
		if n := a.ChangesCount(); n > 0 {
			ui.Text(c, i18n.Tf(loc, "changesCount", map[string]any{"count": n})).
				FontSize(st.FontMeta).TextColor(st.Warning).SingleLine()
		}
		ui.Text(c, i18n.Tf(loc, a.Notice().Key, a.Notice().Args)).FontSize(st.FontMeta).TextColor(st.Faint).SingleLine()
		ui.Spacer(c)

		if line, col, ok := a.CursorLineCol(); ok {
			ui.Text(c, i18n.Tf(loc, "statusLineCol", map[string]any{"line": line, "col": col})).
				FontSize(st.FontMeta).TextColor(st.Muted)
			ui.Text(c, i18n.Tf(loc, "statusSpaces", map[string]any{"n": 4})).
				FontSize(st.FontMeta).TextColor(st.Muted)
		}
		ui.Text(c, "UTF-8").FontSize(st.FontMeta).TextColor(st.Faint)
		if eol := a.LineEnding(); eol != "" {
			ui.Text(c, eol).FontSize(st.FontMeta).TextColor(st.Faint)
		}
		language := a.LanguageName()
		if language == "" {
			language = i18n.T(loc, "statusPlainText")
		}
		ui.Text(c, language).FontSize(st.FontMeta).TextColor(st.Muted)

		st.Chip(c, i18n.T(loc, "panelToggle"), a.PanelOpen(), func() { a.Dispatch(app.TogglePanel{}) })
		st.Chip(c, i18n.T(loc, "sidebarRight"), a.RightOpen(), func() { a.Dispatch(app.ToggleRight{}) })
	})
}
