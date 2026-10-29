package view

import (
	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/i18n"
	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
)

// bottomPane is the Terminal, Problems and Output panel. When it is closed the
// shell does not draw it at all, so the editor gets the room back.
func bottomPane(c *ui.Context, a *app.App, st style) {
	loc := c.Locale()
	ui.Column(c).Fill().Background(st.panel).Children(func() {
		st.hrule(c)
		ui.Row(c).Height(st.titleH + 6).PaddingX(st.gap).Gap(2).AlignItems(ui.Center).Children(func() {
			st.chip(c, i18n.T(loc, "panelTerminal"), a.Layout.PanelTab == 0, func() { a.Layout.PanelTab = 0 })
			st.chip(c, i18n.T(loc, "panelProblems"), a.Layout.PanelTab == 1, func() { a.Layout.PanelTab = 1 })
			st.chip(c, i18n.T(loc, "panelOutput"), a.Layout.PanelTab == 2, func() { a.Layout.PanelTab = 2 })
			ui.Spacer(c)
			if a.Layout.PanelTab == 0 {
				st.chip(c, i18n.T(loc, "terminalNew"), false, func() { a.Dispatch(app.NewTerminal{}) })
				if activeTerminal(a) != nil {
					st.chip(c, i18n.T(loc, "terminalClose"), false, func() {
						a.Dispatch(app.CloseTerminal{Index: a.Layout.ActiveTerm})
					})
				}
			}
			st.chip(c, i18n.T(loc, "panelHide"), false, func() { a.Dispatch(app.TogglePanel{}) })
		})
		st.hrule(c)
		switch a.Layout.PanelTab {
		case 0:
			terminalPage(c, a, st)
		case 1:
			ui.Text(c, i18n.T(loc, "panelProblemsHint")).FontSize(st.fsMeta).TextColor(st.muted).Padding(st.pad)
		default:
			ui.Text(c, i18n.T(loc, "panelOutputHint")).FontSize(st.fsMeta).TextColor(st.muted).Padding(st.pad)
		}
	})
}

// activeTerminal returns the selected session, or nil when there is none.
func activeTerminal(a *app.App) *app.Terminal {
	terms := a.Terminals()
	i := a.Layout.ActiveTerm
	if i < 0 || i >= len(terms) {
		return nil
	}
	return terms[i]
}

func terminalPage(c *ui.Context, a *app.App, st style) {
	loc := c.Locale()
	terms := a.Terminals()
	if len(terms) == 0 {
		ui.Column(c).Grow(1).Padding(st.pad).Gap(st.gap).Children(func() {
			ui.Text(c, i18n.T(loc, "terminalEmpty")).FontSize(st.fsMeta).TextColor(st.muted)
			if ui.Button(c, i18n.T(loc, "terminalNew")).Clicked() {
				a.Dispatch(app.NewTerminal{})
			}
		})
		return
	}
	if len(terms) > 1 {
		ui.Row(c).Height(st.rowH + 4).PaddingX(st.gap).Gap(2).AlignItems(ui.Center).Children(func() {
			for i, t := range terms {
				index := i
				label := i18n.Tf(loc, "terminalTitle", map[string]any{"num": t.Num})
				if t.Exited {
					label = i18n.Tf(loc, "terminalExited", map[string]any{"num": t.Num, "code": t.ExitCode})
				}
				st.chip(c, label, i == a.Layout.ActiveTerm, func() { a.Layout.ActiveTerm = index })
			}
		})
	}
	if t := activeTerminal(a); t != nil && t.Term != nil {
		terminal.View(c, t.Term).Grow(1)
	}
}
