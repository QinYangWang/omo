package view

import (
	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/i18n"
	"github.com/QinYangWang/omo/internal/kit"
	"github.com/egoist/mygo/ui"
)

// sessionPane is the middle column's home: the conversation with the agent,
// shown while no file is open. ACP chat arrives in P2, so it says what works
// today and points at the terminal, where an agent can run now.
func sessionPane(c *ui.Context, a *app.App, st kit.Theme) {
	loc := c.Locale()
	ui.Column(c).Fill().Center().Padding(32).Children(func() {
		ui.Column(c).Width(460).MaxWidthPercent(100).Gap(12).Children(func() {
			ui.Icon(c, kit.IconLogo).FontSize(30).TextColor(st.Accent)
			ui.Text(c, i18n.T(loc, "sessionHeading")).FontSize(24).Bold().LetterSpacing(-0.3).
				TextColor(st.Text)
			ui.Row(c).Gap(6).PaddingY(2).Children(func() {
				ui.Icon(c, kit.IconFolder).FontSize(12).TextColor(st.Faint)
				ui.Text(c, a.WorkspaceName()).FontSize(st.FontMeta).TextColor(st.Muted).SingleLine()
				if branch := a.Branch(); branch != "" {
					ui.Icon(c, kit.IconGit).FontSize(12).TextColor(st.Faint).PaddingX(4)
					ui.Text(c, branch).FontSize(st.FontMeta).TextColor(st.Muted).SingleLine()
				}
			})
			ui.Text(c, i18n.T(loc, "chatHint")).FontSize(st.FontUI).TextColor(st.Muted)
			ui.Text(c, i18n.Tf(loc, a.AgentNotice().Key, a.AgentNotice().Args)).
				FontSize(st.FontMeta).TextColor(st.Faint)
			ui.Column(c).PaddingY(4).Children(func() {
				st.ActionRow(c, kit.IconTerminal, i18n.T(loc, "terminalNew"), newTerminalKeys(), func() {
					a.Run(app.CmdNewTerminal)
				})
			})
			ui.Text(c, i18n.T(loc, "chatTerminalHint")).FontSize(st.FontMeta).TextColor(st.Faint)
		})
	})
}
