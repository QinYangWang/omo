package view

import (
	"strings"

	"github.com/QinYangWang/omo/internal/agent"
	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/i18n"
	"github.com/QinYangWang/omo/internal/kit"
	"github.com/egoist/mygo/ui"
)

// sessionPane is the middle column's home and the ACP client surface. The first
// tab in the editor strip returns here without destroying the running session.
func sessionPane(c *ui.Context, a *app.App, st kit.Theme) {
	loc := c.Locale()
	ui.Column(c).Fill().Background(st.BG).Children(func() {
		ui.Row(c).Height(st.TitleH).PaddingX(st.Pad).Gap(st.Gap).AlignItems(ui.Center).Children(func() {
			ui.Icon(c, kit.IconChat).FontSize(st.FontUI).TextColor(st.Accent)
			ui.Text(c, activeAgentName(a, loc)).FontSize(st.FontUI).Bold().TextColor(st.Text)
			ui.Text(c, i18n.Tf(loc, a.AgentNotice().Key, a.AgentNotice().Args)).FontSize(st.FontMeta).TextColor(st.Muted)
			ui.Spacer(c)
			st.IconButton(c, kit.IconPlus, i18n.T(loc, "agentManage"), false, func() { a.Dispatch(app.ShowAgents{}) })
			if len(a.AgentDefinitions()) > 0 {
				if a.AgentState() == agent.StateDisconnected || a.AgentState() == agent.StateError {
					st.IconButton(c, kit.IconRun, i18n.T(loc, "agentStart"), false, func() {
						a.Dispatch(app.StartAgent{ID: a.ActiveAgentID()})
					})
				} else {
					st.IconButton(c, kit.IconRefresh, i18n.T(loc, "agentRestart"), false, func() { a.Dispatch(app.RestartAgent{}) })
				}
			}
		})
		st.HRule(c)
		if len(a.AgentDefinitions()) == 0 {
			ui.Column(c).Fill().Center().Padding(st.Pad).Gap(st.Gap).Children(func() {
				ui.Text(c, i18n.T(loc, "sessionHeading")).FontSize(st.FontUI).Bold().TextColor(st.Text)
				ui.Text(c, i18n.T(loc, "agentConfigHint")).FontSize(st.FontMeta).TextColor(st.Muted)
				st.ActionRow(c, kit.IconPlus, i18n.T(loc, "agentAdd"), "", func() { a.Dispatch(app.EditAgentConfig{}) })
			})
			return
		}
		ui.Scroll(c).Grow(1).Children(func() {
			ui.Column(c).Padding(st.Pad).Gap(st.Gap).Children(func() {
				if len(a.ChatItems()) == 0 {
					ui.Text(c, i18n.T(loc, "sessionHeading")).FontSize(st.FontUI).Bold().TextColor(st.Text)
					ui.Text(c, i18n.T(loc, "chatHint")).FontSize(st.FontMeta).TextColor(st.Muted)
				}
				for _, item := range a.ChatItems() {
					chatItem(c, st, loc, item)
				}
			})
		})
		st.HRule(c)
		ui.Row(c).Padding(st.Gap).Gap(st.Gap).AlignItems(ui.End).Children(func() {
			ui.TextArea(c, a.AgentInput()).Grow(1).Height(st.TabH * 2).
				Placeholder(i18n.T(loc, "chatInputPlaceholder")).Label(i18n.T(loc, "chatInputPlaceholder"))
			if a.AgentState() == agent.StatePrompting || a.AgentState() == agent.StateStarting {
				if ui.Button(c, i18n.T(loc, "agentCancel")).Clicked() {
					a.Dispatch(app.CancelTurn{})
				}
			} else if ui.PrimaryButton(c, i18n.T(loc, "chatSend")).Clicked() {
				a.Dispatch(app.SendPrompt{})
			}
		})
	})
}

func activeAgentName(a *app.App, loc string) string {
	for _, def := range a.AgentDefinitions() {
		if def.ID == a.ActiveAgentID() {
			return def.Name
		}
	}
	return i18n.T(loc, "agentUnconfigured")
}

func chatItem(c *ui.Context, st kit.Theme, loc string, item app.ChatItem) {
	label, color := i18n.T(loc, "chatAgent"), st.Text
	switch {
	case item.User:
		label = i18n.T(loc, "chatYou")
	case item.Kind == agent.EventThought:
		label, color = i18n.T(loc, "chatThought"), st.Muted
	case item.Kind == agent.EventTool:
		label, color = i18n.T(loc, "chatTool"), st.Accent
	case item.Kind == agent.EventPlan:
		label, color = i18n.T(loc, "chatPlan"), st.Accent
	}
	ui.Column(c).Gap(st.Gap).Children(func() {
		ui.Text(c, label).FontSize(st.FontMeta).Bold().TextColor(color)
		ui.Text(c, item.Text).FontSize(st.FontUI).TextColor(st.Text)
	})
}

// agentDialogs are overlays of the shell, not panels: they remain available
// while an editor or diff tab covers the session pane.
func agentDialogs(c *ui.Context, a *app.App, st kit.Theme) {
	loc := c.Locale()
	if a.AgentPickerOpen() {
		open := true
		ui.Modal(c, &open, func() {
			ui.Column(c).Gap(st.Gap).Children(func() {
				ui.Text(c, i18n.T(loc, "agentManage")).FontSize(st.FontUI).Bold().TextColor(st.Text)
				for _, def := range a.AgentDefinitions() {
					d := def
					st.Row(c, kit.RowSpec{Icon: kit.IconChat, Label: d.Name, Meta: d.Executable, Active: d.ID == a.ActiveAgentID(), OnClick: func() {
						a.Dispatch(app.SelectAgent{ID: d.ID})
					}})
				}
				st.ActionRow(c, kit.IconPlus, i18n.T(loc, "agentAdd"), "", func() { a.Dispatch(app.EditAgentConfig{}) })
				if a.ActiveAgentID() != "" {
					st.ActionRow(c, kit.IconChat, i18n.T(loc, "agentEdit"), "", func() {
						a.Dispatch(app.EditAgentConfig{ID: a.ActiveAgentID()})
					})
					st.ActionRow(c, kit.IconTrash, i18n.T(loc, "agentDelete"), "", func() {
						a.Dispatch(app.DeleteAgent{ID: a.ActiveAgentID()})
					})
				}
			})
		})
		if !open {
			a.Dispatch(app.CloseAgents{})
		}
	}
	if a.AgentConfigForm().Open {
		agentConfigDialog(c, a, st)
	}
	if id := a.TrustAgentID(); id != "" {
		trustDialog(c, a, st, id)
	}
	if p := a.Permission(); p != nil {
		permissionDialog(c, a, st, p)
	}
}

func agentConfigDialog(c *ui.Context, a *app.App, st kit.Theme) {
	loc := c.Locale()
	d := a.AgentConfigForm()
	open := true
	ui.Modal(c, &open, func() {
		ui.Column(c).Gap(st.Gap).Children(func() {
			ui.Text(c, i18n.T(loc, "agentConfigTitle")).FontSize(st.FontUI).Bold().TextColor(st.Text)
			ui.Field(c, i18n.T(loc, "agentName"), func() { ui.TextInput(c, &d.Name) })
			ui.Field(c, i18n.T(loc, "agentExecutable"), func() { ui.TextInput(c, &d.Executable).Placeholder("codex") })
			ui.Field(c, i18n.T(loc, "agentArgs"), func() {
				ui.TextArea(c, &d.Args).Height(st.TabH * 2).Placeholder("--acp")
			}).Description(i18n.T(loc, "agentOnePerLine"))
			ui.Field(c, i18n.T(loc, "agentEnv"), func() { ui.TextArea(c, &d.Env).Height(st.TabH * 2) }).Description(i18n.T(loc, "agentOnePerLine"))
			ui.Row(c).Gap(st.Gap).Children(func() {
				if ui.PrimaryButton(c, i18n.T(loc, "agentSave")).Clicked() {
					a.Dispatch(app.SaveAgentConfig{})
				}
				if ui.Button(c, i18n.T(loc, "dialogCancel")).Clicked() {
					a.Dispatch(app.CloseAgentConfig{})
				}
			})
		})
	})
	if !open {
		a.Dispatch(app.CloseAgentConfig{})
	}
}

func trustDialog(c *ui.Context, a *app.App, st kit.Theme, id string) {
	loc := c.Locale()
	open := true
	ui.Modal(c, &open, func() {
		ui.Column(c).Gap(st.Gap).Children(func() {
			ui.Text(c, i18n.T(loc, "agentTrustTitle")).FontSize(st.FontUI).Bold().TextColor(st.Text)
			ui.Text(c, i18n.Tf(loc, "agentTrustMessage", map[string]any{"name": activeAgentName(a, loc)})).FontSize(st.FontMeta).TextColor(st.Muted)
			details := a.TrustDetails()
			ui.Text(c, details.Executable).FontSize(st.FontMeta).TextColor(st.Text).SingleLine()
			for _, arg := range details.Args {
				ui.Text(c, arg).FontSize(st.FontMeta).TextColor(st.Muted).SingleLine()
			}
			ui.Text(c, details.Cwd).FontSize(st.FontMeta).TextColor(st.Muted).SingleLine()
			if len(details.Env) > 0 {
				ui.Text(c, i18n.T(loc, "agentTrustEnv")+": "+strings.Join(details.Env, ", ")).FontSize(st.FontMeta).TextColor(st.Muted)
			}
			ui.Row(c).Gap(st.Gap).Children(func() {
				if ui.PrimaryButton(c, i18n.T(loc, "agentTrustRun")).Clicked() {
					a.Dispatch(app.TrustAgent{ID: id})
				}
				if ui.Button(c, i18n.T(loc, "dialogCancel")).Clicked() {
					a.Dispatch(app.TrustAgent{ID: ""})
				}
			})
		})
	})
	if !open {
		a.Dispatch(app.TrustAgent{ID: ""})
	}
}

func permissionDialog(c *ui.Context, a *app.App, st kit.Theme, p *app.AgentPermission) {
	loc := c.Locale()
	open := true
	ui.Modal(c, &open, func() {
		ui.Column(c).Gap(st.Gap).Children(func() {
			ui.Text(c, i18n.T(loc, "permissionTitle")).FontSize(st.FontUI).Bold().TextColor(st.Text)
			ui.Text(c, p.Title).FontSize(st.FontUI).TextColor(st.Text)
			if p.Kind != "" {
				ui.Text(c, p.Kind).FontSize(st.FontMeta).TextColor(st.Muted)
			}
			for _, path := range p.Paths {
				ui.Text(c, path).FontSize(st.FontMeta).TextColor(st.Text).SingleLine()
			}
			for _, arg := range p.Command {
				ui.Text(c, arg).FontSize(st.FontMeta).TextColor(st.Text).SingleLine()
			}
			if p.Input != "" {
				ui.Text(c, p.Input).FontSize(st.FontMeta).TextColor(st.Muted)
			}
			ui.Text(c, i18n.T(loc, "permissionHint")).FontSize(st.FontMeta).TextColor(st.Muted)
			if ui.PrimaryButton(c, i18n.T(loc, "permissionCancel")).Clicked() {
				a.Dispatch(app.CancelTurn{})
			}
			for _, option := range p.Options {
				if option.Kind == "allow_always" {
					// shortcut: allow_always stays hidden until scoped grants persist in P3.
					continue
				}
				id := option.ID
				label := option.Name
				if strings.TrimSpace(label) == "" {
					label = option.Kind
				}
				if ui.Button(c, label).Clicked() {
					a.Dispatch(app.ResolvePermission{OptionID: id})
				}
			}
		})
	})
	if !open {
		a.Dispatch(app.CancelTurn{})
	}
}
