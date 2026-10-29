package view

import (
	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/i18n"
	"github.com/egoist/mygo/ui"
)

// chatPanel is the right-hand panel. ACP chat arrives in P2; until then it says
// so and points at the terminal, where an agent can run today. The panel can be
// dragged (the split divider) and closed (the hide action or the View menu).
func chatPanel(c *ui.Context, a *app.App, st style) {
	loc := c.Locale()
	ui.Column(c).Fill().Background(st.panel).Children(func() {
		ui.Row(c).Height(st.titleH).PaddingX(st.pad).Gap(st.gap).AlignItems(ui.Center).Children(func() {
			ui.Text(c, i18n.T(loc, "chatTitle")).FontSize(st.fsMeta).Bold().TextColor(st.muted)
			ui.Spacer(c)
			close := ui.Box(c).Width(18).Height(18).Justify(ui.Center).AlignItems(ui.Center).Focusable()
			close = close.Children(func() {
				ui.Text(c, "×").FontSize(st.fsUI).TextColor(st.muted)
			})
			if close.Hovered() {
				close.Background(st.selected)
			}
			close.OnClick(func() { a.Dispatch(app.ToggleChat{}) })
			_ = i18n.T(loc, "chatHide")
		})
		st.hrule(c)
		// The empty state sits in the middle of the panel, not pinned to the top,
		// so the space reads as waiting for messages rather than as a gap.
		ui.Spacer(c)
		ui.Column(c).Padding(st.pad).Gap(6).Children(func() {
			ui.Text(c, i18n.Tf(loc, a.AgentNotice().Key, a.AgentNotice().Args)).
				FontSize(st.fsMeta).TextColor(st.muted)
			ui.Text(c, i18n.T(loc, "chatHint")).FontSize(st.fsUI).TextColor(st.text)
			ui.Text(c, i18n.T(loc, "chatTerminalHint")).FontSize(st.fsMeta).TextColor(st.muted)
		})
		ui.Spacer(c)
		st.hrule(c)
		ui.Row(c).Height(st.tabH).PaddingX(st.gap).AlignItems(ui.Center).Children(func() {
			st.chip(c, i18n.T(loc, "terminalNew"), false, func() { a.Run(app.CmdNewTerminal) })
		})
	})
}
