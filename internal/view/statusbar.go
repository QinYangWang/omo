package view

import (
	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/i18n"
	"github.com/egoist/mygo/ui"
)

// statusBar mirrors the reference design: repository state on the left, the
// caret and file facts on the right, with panel toggles at the end.
func statusBar(c *ui.Context, a *app.App, st style) {
	loc := c.Locale()

	branch := a.Branch()
	if branch == "" {
		branch = i18n.T(loc, "statusNoRepo")
	}

	ui.Row(c).Height(st.barH).PaddingX(st.pad).Gap(st.gap + 2).AlignItems(ui.Center).Background(st.header).Children(func() {
		ui.Icon(c, iconGit).FontSize(12).TextColor(st.muted)
		ui.Text(c, branch).FontSize(st.fsMeta).TextColor(st.muted)
		if n := a.ChangesCount(); n > 0 {
			ui.Text(c, i18n.Tf(loc, "changesCount", map[string]any{"count": n})).FontSize(st.fsMeta).TextColor(st.muted)
		}
		ui.Text(c, i18n.Tf(loc, a.Notice().Key, a.Notice().Args)).FontSize(st.fsMeta).TextColor(st.muted)
		ui.Spacer(c)

		if line, col, ok := a.CursorLineCol(); ok {
			ui.Text(c, i18n.Tf(loc, "statusLineCol", map[string]any{"line": line, "col": col})).
				FontSize(st.fsMeta).TextColor(st.muted)
			ui.Text(c, i18n.Tf(loc, "statusSpaces", map[string]any{"n": 4})).
				FontSize(st.fsMeta).TextColor(st.muted)
		}
		ui.Text(c, "UTF-8").FontSize(st.fsMeta).TextColor(st.muted)
		if eol := a.LineEnding(); eol != "" {
			ui.Text(c, eol).FontSize(st.fsMeta).TextColor(st.muted)
		}
		language := a.LanguageName()
		if language == "" {
			language = i18n.T(loc, "statusPlainText")
		}
		ui.Text(c, language).FontSize(st.fsMeta).TextColor(st.muted)

		st.chip(c, i18n.T(loc, "panelToggle"), a.PanelOpen(), func() { a.Dispatch(app.TogglePanel{}) })
		st.chip(c, i18n.T(loc, "chatTitle"), a.ChatOpen(), func() { a.Dispatch(app.ToggleChat{}) })
	})
}
