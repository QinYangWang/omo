// Package ui renders the MyGo native chat window.
package ui

import (
	"fmt"
	"path/filepath"
	"strings"

	mygoui "github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"

	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/chat"
	"github.com/QinYangWang/omo/internal/plugins"
	"github.com/QinYangWang/omo/internal/widgets"
)

type view struct {
	app        *app.App
	messages   mygoui.ListState
	sessions   mygoui.ListState
	models     mygoui.ListState
	md         markdown.Options
	scrollOnce bool
	plugin     *widgets.State
}

// New returns the view function for mygo.WindowOptions.Content.
func New(a *app.App) func(*mygoui.Context) {
	v := &view{app: a, plugin: widgets.NewState()}
	return v.build
}

func (v *view) build(c *mygoui.Context) {
	a := v.app
	c.SetTheme(theme(c.Theme()))
	if a.ShowPlugins {
		v.plugins(c)
		return
	}
	if !a.ShowSettings {
		if plugin := a.ActiveUIPlugin(); plugin != nil {
			schema, err := a.PluginSchema(plugin)
			if err != nil {
				v.pluginFailure(c, plugin, err)
				return
			}
			widgets.Render(c, schema, v.plugin, v)
			return
		}
	}
	t := c.Theme()
	mygoui.Row(c).Fill().Background(t.Background).Children(func() {
		v.sidebar(c)
		v.main(c)
	})
}

func (v *view) sidebar(c *mygoui.Context) {
	t := c.Theme()
	p := colors(t)
	a := v.app
	mygoui.Column(c).
		Width(252).
		FillHeight().
		Background(p.rail).
		BorderWidth(0, 1, 0, 0).
		BorderColor(p.border).
		Children(func() {
			mygoui.Row(c).Height(max(c.TitleBar().Bottom, 44)).Shrink(0).DragWindow().
				Padding(0, 10, 0, 14).Gap(8).AlignItems(mygoui.Center).Children(func() {
				mygoui.Box(c).Size(20, 20).Radius(6).Gradient(p.accent, p.accent.Mix(p.rail, 0.45), 135).
					AlignItems(mygoui.Center).Justify(mygoui.Center).Children(func() {
					mygoui.Text(c, "o").FontSize(12).Bold().TextColor(p.onAccent)
				})
				mygoui.Text(c, "omo").FontSize(13.5).Bold()
			})
			mygoui.Column(c).Padding(10, 10, 6, 10).Gap(2).Children(func() {
				v.navItem(c, iconPlus, "New chat", false, func() { a.StartNewChat() })
				v.navItem(c, iconGrid, "Plugins", a.ShowPlugins, func() { a.OpenPlugins() })
				v.navItem(c, iconSliders, "Settings", a.ShowSettings, func() { a.OpenSettings() })
			})

			mygoui.Text(c, "SESSIONS").FontSize(10).Bold().TextColor(p.muted).Padding(12, 10, 4, 14)
			v.sessionList(c)

			mygoui.Column(c).Padding(10, 10, 10, 10).Gap(8).Children(func() {
				mygoui.Divider(c).Background(p.border)
				footer := mygoui.Row(c).Padding(5, 6).Radius(9).Gap(9).AlignItems(mygoui.Center)
				footer.Cursor(mygoui.CursorPointer).OnClick(func() { a.ChooseWorkspace() }).
					Tooltip("Change workspace")
				if footer.Hovered() {
					footer.Background(p.railHover)
				}
				footer.Children(func() {
					mygoui.Box(c).Size(26, 26).Radius(13).Gradient(p.accent, p.accent.Mix(p.rail, 0.45), 135).
						AlignItems(mygoui.Center).Justify(mygoui.Center).Children(func() {
						mygoui.Icon(c, iconFolder).FontSize(13).TextColor(p.onAccent)
					})
					mygoui.Column(c).Grow(1).Gap(1).Children(func() {
						mygoui.Text(c, workspaceName(a)).FontSize(12).Bold().SingleLine()
						mygoui.Text(c, "Workspace").FontSize(11).TextColor(p.muted).SingleLine()
					})
					if iconButton(c, iconFolder, "Change workspace") {
						a.ChooseWorkspace()
					}
				})
			})
		})
}

// workspaceName is the last part of the workspace path, or a hint that none
// is chosen.
func workspaceName(a *app.App) string {
	if !a.HasWorkspace() {
		return "No workspace"
	}
	return filepath.Base(strings.TrimRight(a.WorkspaceLabel(), `\/`))
}

func (v *view) pageTitle() string {
	if v.app.ShowPlugins {
		return "Plugins"
	}
	if v.app.ShowSettings {
		return "Settings"
	}
	if v.app.Session != nil {
		return v.app.Session.Title
	}
	return "New chat"
}

func (v *view) navItem(c *mygoui.Context, ic *mygoui.SVG, label string, active bool, action func()) {
	p := colors(c.Theme())
	row := mygoui.ButtonBase(c).Padding(6, 9).Radius(8).Gap(10).AlignItems(mygoui.Center).Label(label)
	if active {
		row.Background(p.card)
	} else if row.Hovered() {
		row.Background(p.railHover)
	}
	if row.Clicked() {
		action()
	}
	row.Children(func() {
		mygoui.Icon(c, ic).FontSize(15).TextColor(p.muted)
		mygoui.Text(c, label).FontSize(13).Grow(1)
		if active {
			mygoui.Box(c).Size(5, 5).Radius(3).Background(p.accent)
		}
	})
}

// iconButton is a borderless square button showing an icon only.
func iconButton(c *mygoui.Context, ic *mygoui.SVG, label string) bool {
	p := colors(c.Theme())
	b := mygoui.ButtonBase(c).Size(24, 24).Radius(7).AlignItems(mygoui.Center).Justify(mygoui.Center).Label(label)
	if b.Hovered() {
		b.Background(p.railHover)
	}
	b.Tooltip(label)
	b.Children(func() {
		mygoui.Icon(c, ic).FontSize(15).TextColor(p.muted)
	})
	return b.Clicked()
}

func (v *view) main(c *mygoui.Context) {
	t := c.Theme()
	a := v.app
	mygoui.Column(c).Grow(1).FillHeight().Background(t.Background).Children(func() {
		v.headerBar(c, v.pageTitle(), workspaceName(a), func() {
			if a.ShowSettings {
				if iconButton(c, iconArrowLeft, "Back to chat") {
					a.ShowSettings = false
				}
				return
			}
			if iconButton(c, iconFolder, "Change workspace") {
				a.ChooseWorkspace()
			}
			if iconButton(c, iconGrid, "Plugins") {
				a.OpenPlugins()
			}
			if iconButton(c, iconSliders, "Settings") {
				a.OpenSettings()
			}
		})

		if a.ShowSettings {
			v.settings(c)
			return
		}

		if a.Failure != "" {
			v.banner(c, a.Failure)
		}

		v.transcript(c)
		v.composer(c)
	})
}

// headerBar draws the window's draggable title row, clear of the window
// controls, and the actions that go at its end.
func (v *view) headerBar(c *mygoui.Context, title, subtitle string, actions func()) {
	p := colors(c.Theme())
	bar := c.TitleBar()
	row := mygoui.Row(c).Height(44).Shrink(0).
		Padding(0, bar.Right+16, 0, 18).
		Gap(4).AlignItems(mygoui.Center).DragWindow().
		BorderWidth(0, 0, 1, 0).BorderColor(p.border)
	row.Children(func() {
		mygoui.Column(c).Grow(1).Gap(1).Children(func() {
			mygoui.Text(c, title).FontSize(13.5).Bold().SingleLine()
			mygoui.Text(c, subtitle).FontSize(11).TextColor(p.muted).SingleLine()
		})
		if actions != nil {
			actions()
		}
	})
}

func (v *view) banner(c *mygoui.Context, text string) {
	t := c.Theme()
	mygoui.Row(c).Padding(10, 18, 0, 18).Children(func() {
		mygoui.Row(c).FillWidth().Padding(8, 12).Radius(9).Gap(8).
			Background(t.Danger.Alpha(0.12)).Border(1, t.Danger.Alpha(0.35)).Children(func() {
			mygoui.Text(c, text).FontSize(12).TextColor(t.Danger).Wrap()
		})
	})
}

// sessionRow is one row of the session rail: a workspace heading or a chat.
type sessionRow struct {
	header  bool
	group   string
	session *chat.Session
}

func (v *view) sessionRows() []sessionRow {
	a := v.app
	rows := make([]sessionRow, 0, len(a.Sessions)+4)
	seen := map[string]bool{}
	for i := range a.Sessions {
		s := &a.Sessions[i]
		if !seen[s.Workspace] {
			seen[s.Workspace] = true
			rows = append(rows, sessionRow{header: true, group: s.Workspace})
		}
		rows = append(rows, sessionRow{session: s})
	}
	return rows
}

func groupName(workspace string) string {
	if strings.TrimSpace(workspace) == "" {
		return "No workspace"
	}
	return filepath.Base(strings.TrimRight(workspace, `\/`))
}

func (v *view) sessionList(c *mygoui.Context) {
	p := colors(c.Theme())
	a := v.app
	rows := v.sessionRows()
	if len(rows) == 0 {
		mygoui.Text(c, "No conversations yet").FontSize(11).TextColor(p.muted).Padding(4, 12, 8, 14)
		return
	}
	list := &v.sessions
	list.Key = func(i int) any {
		if rows[i].header {
			return "group:" + rows[i].group
		}
		return rows[i].session.ID
	}
	mygoui.List(c, list, len(rows), func(i int) {
		row := rows[i]
		if row.header {
			mygoui.Row(c).Padding(5, 12, 6, 20).Gap(7).AlignItems(mygoui.Center).Children(func() {
				mygoui.Icon(c, iconFolder).FontSize(12).TextColor(p.muted)
				mygoui.Text(c, groupName(row.group)).FontSize(11).TextColor(p.muted).SingleLine().Grow(1)
			})
			return
		}
		s := row.session
		selected := a.Session != nil && a.Session.ID == s.ID
		item := mygoui.Row(c).Padding(6, 10, 6, 26).Radius(8).Gap(8).AlignItems(mygoui.Center)
		if selected {
			item.Background(p.card)
		} else if item.Hovered() {
			item.Background(p.railHover)
		}
		item.Cursor(mygoui.CursorPointer).OnClick(func() { a.OpenSession(s.ID) }).Children(func() {
			mygoui.Text(c, s.Title).FontSize(12.5).SingleLine().Grow(1)
			if selected {
				mygoui.Box(c).Size(4, 4).Radius(2).Background(p.accent)
			}
		})
	}).Grow(1)
}

func (v *view) transcript(c *mygoui.Context) {
	t := c.Theme()
	p := colors(t)
	a := v.app
	if len(a.Messages) == 0 && a.Partial == "" && a.Status != "running" && a.Status != "tool" {
		mygoui.Column(c).Grow(1).Justify(mygoui.Center).Padding(24, 36).Gap(10).Children(func() {
			mygoui.Text(c, "How can I help you today?").FontSize(24).Bold()
			if a.HasWorkspace() {
				mygoui.Text(c, "Working in "+workspaceName(a)).FontSize(12).TextColor(p.muted).Wrap()
			} else {
				mygoui.Text(c, "Choose a folder to start.").FontSize(12).TextColor(p.muted).Wrap()
				if mygoui.PrimaryButton(c, "Choose a workspace").Clicked() {
					a.ChooseWorkspace()
				}
			}
		})
		return
	}
	list := &v.messages
	list.Key = func(i int) any { return i }
	list.FollowEnd = true
	list.FollowAnimation = &mygoui.Smooth
	rows := len(a.Messages)
	streaming := (a.Status == "running" || a.Status == "tool") && a.Partial != ""
	if streaming {
		rows++
	}
	render := func(i int) {
		if i >= len(a.Messages) {
			mygoui.Column(c).MaxWidth(780).Padding(0, 2).Children(func() {
				markdown.Stream(c, a.Partial, &v.md)
			})
			return
		}
		msg := a.Messages[i]
		if msg.Role == "user" {
			mygoui.Row(c).Children(func() {
				mygoui.Spacer(c)
				mygoui.Text(c, msg.Text).
					Selectable().
					Padding(9, 13).
					Radius(14).
					Background(p.card).
					MaxWidth(560)
			})
			return
		}
		mygoui.Column(c).MaxWidth(780).Children(func() {
			markdown.View(c, msg.Text, &v.md)
		})
	}
	mygoui.List(c, list, rows, render).Grow(1).Padding(22, 28, 14, 28).Gap(16).Justify(mygoui.End).Children(func() {
		if a.Status == "tool" {
			mygoui.Text(c, "Working in the workspace…").FontSize(12).TextColor(p.muted)
		} else if a.Status == "running" && a.Partial == "" {
			mygoui.Row(c).Gap(8).AlignItems(mygoui.Center).Children(func() {
				mygoui.Spinner(c)
				mygoui.Text(c, "Thinking…").FontSize(12).TextColor(p.muted)
			})
		}
	})
}

func (v *view) composer(c *mygoui.Context) {
	p := colors(c.Theme())
	a := v.app
	busy := a.Status == "running" || a.Status == "tool"
	empty := strings.TrimSpace(a.Input) == ""
	mygoui.Row(c).FillWidth().Justify(mygoui.Center).Padding(8, 22, 16, 22).Children(func() {
		mygoui.Column(c).MaxWidth(820).Grow(1).Radius(14).Background(p.card).
			Border(1, p.border).Padding(10, 12, 9, 12).Gap(8).Children(func() {
			mygoui.TextAreaBase(c, &a.Input).
				Placeholder("Message omo").
				Lines(1, 8).
				OnTextKey(func(k mygoui.TextKey) bool {
					if k.Key == mygoui.KeyEnter && k.Mods == 0 {
						text := k.Text()
						k.SetText("")
						a.Send(text)
						return true
					}
					return false
				})
			mygoui.Row(c).Gap(8).AlignItems(mygoui.Center).Children(func() {
				if model := a.Config.Settings.Model; model != "" {
					chip := mygoui.Row(c).Padding(4, 9).Radius(999).Gap(6).AlignItems(mygoui.Center)
					chip.Background(p.rail).Cursor(mygoui.CursorPointer).
						OnClick(func() { a.OpenSettings() }).Tooltip("Change model")
					if chip.Hovered() {
						chip.Background(p.railHover)
					}
					chip.Children(func() {
						mygoui.Text(c, model).FontSize(11).TextColor(p.muted).SingleLine().MaxWidth(260)
						mygoui.Icon(c, iconChevronDown).FontSize(11).TextColor(p.muted)
					})
				}
				mygoui.Spacer(c)
				if busy {
					stop := mygoui.ButtonBase(c).Size(28, 28).Radius(14).Label("Stop")
					stop.Background(p.railHover).AlignItems(mygoui.Center).Justify(mygoui.Center)
					if stop.Hovered() {
						stop.Background(p.border)
					}
					if stop.Clicked() {
						a.Stop()
					}
					stop.Children(func() { mygoui.Icon(c, iconStop).FontSize(14).TextColor(p.text) })
					return
				}
				send := mygoui.ButtonBase(c).Size(28, 28).Radius(14).Label("Send")
				send.AlignItems(mygoui.Center).Justify(mygoui.Center)
				send.Disabled(empty)
				send.Background(p.accent)
				send.Children(func() { mygoui.Icon(c, iconArrowUp).FontSize(15).TextColor(p.onAccent) })
				if send.Clicked() {
					a.Send(a.Input)
				}
			})
		})
	})
}

func (v *view) pluginFailure(c *mygoui.Context, plugin *plugins.Installed, err error) {
	t := c.Theme()
	mygoui.Column(c).Fill().Padding(24).Gap(12).Background(t.Background).Children(func() {
		mygoui.Text(c, "UI plugin failed").FontSize(20).Bold()
		mygoui.Text(c, plugin.Name).FontSize(14).TextColor(t.TextMuted)
		mygoui.Text(c, err.Error()).FontSize(12).TextColor(t.Danger).Wrap()
		mygoui.Row(c).Gap(8).Children(func() {
			if mygoui.PrimaryButton(c, "Use built-in UI").Clicked() {
				v.app.UseBuiltinUI()
			}
			if mygoui.Button(c, "Plugins").Clicked() {
				v.app.OpenPlugins()
			}
		})
	})
}

func (v *view) plugins(c *mygoui.Context) {
	t := c.Theme()
	a := v.app
	mygoui.Row(c).Fill().Background(t.Background).Children(func() {
		v.sidebar(c)
		mygoui.Column(c).Grow(1).FillHeight().Children(func() {
			v.headerBar(c, "Plugins", "Active UI: "+a.ActiveUIName(), func() {
				back := mygoui.ButtonBase(c).Padding(5, 9).Radius(7).Gap(6).AlignItems(mygoui.Center).Label("Back to chat")
				if back.Hovered() {
					back.Background(t.SurfaceHover)
				}
				if back.Clicked() {
					a.ClosePlugins()
				}
				back.Children(func() {
					mygoui.Icon(c, iconArrowLeft).FontSize(14).TextColor(t.TextMuted)
					mygoui.Text(c, "Back to chat").FontSize(12).TextColor(t.TextMuted)
				})
			})

			mygoui.Scroll(c).Grow(1).Children(func() {
				mygoui.Column(c).FillWidth().Padding(20, 24).Gap(12).Children(func() {
					mygoui.Text(c, "Declarative native UI plugins. Install from a folder or a shared ZIP; a UI plugin can replace the entire main view.").
						FontSize(12).TextColor(t.TextMuted).Wrap()
					if a.PluginNotice != "" {
						mygoui.Text(c, a.PluginNotice).FontSize(11).TextColor(t.TextMuted).Wrap()
					}
					if a.PluginErr != "" {
						mygoui.Text(c, a.PluginErr).FontSize(11).TextColor(t.Danger).Wrap()
					}

					mygoui.Divider(c)
					mygoui.Row(c).Gap(8).AlignItems(mygoui.Center).Wrap().Children(func() {
						mygoui.Text(c, "Add a plugin").FontSize(15).Bold().Grow(1)
						if mygoui.Button(c, "Install folder").Clicked() {
							a.InstallPluginFolder()
						}
						if mygoui.PrimaryButton(c, "Install ZIP").Clicked() {
							a.InstallPluginZip()
						}
					})

					mygoui.Row(c).Gap(8).AlignItems(mygoui.Center).Children(func() {
						mygoui.Text(c, "Installed").FontSize(15).Bold().Grow(1)
						if mygoui.Button(c, "Use built-in UI").Clicked() {
							a.UseBuiltinUI()
						}
					})
					installed := a.PluginList()
					if len(installed) == 0 {
						mygoui.Text(c, "No plugins installed yet.").FontSize(12).TextColor(t.TextMuted)
					}
					for _, plugin := range installed {
						v.installedPlugin(c, plugin)
					}

					mygoui.Divider(c)
					mygoui.Text(c, "Plugin directory: "+a.PluginRoot()).FontSize(11).TextColor(t.TextMuted).Selectable().Wrap()
				})
			})
		})
	})
}

func (v *view) installedPlugin(c *mygoui.Context, plugin plugins.Installed) {
	t := c.Theme()
	a := v.app
	mygoui.Column(c).FillWidth().Padding(12).Radius(10).Gap(6).Background(t.Surface).Children(func() {
		mygoui.Row(c).Gap(8).AlignItems(mygoui.Center).Children(func() {
			mygoui.Text(c, plugin.Name).FontSize(14).Bold().Grow(1)
			state := "disabled"
			if plugin.Enabled {
				state = "enabled"
			}
			mygoui.Text(c, state).FontSize(10).TextColor(t.TextMuted)
		})
		mygoui.Text(c, plugin.ID+" · v"+plugin.Version).FontSize(10).TextColor(t.TextMuted)
		if plugin.Description != "" {
			mygoui.Text(c, plugin.Description).FontSize(11).TextColor(t.TextMuted).Wrap()
		}
		if len(plugin.Permissions) > 0 {
			mygoui.Text(c, "Permissions: "+strings.Join(plugin.Permissions, ", ")).FontSize(10).TextColor(t.TextMuted).Wrap()
		}
		mygoui.Row(c).Gap(8).Wrap().Children(func() {
			if plugin.Enabled {
				if mygoui.Button(c, "Disable").Clicked() {
					a.SetPluginEnabled(plugin.ID, false)
				}
			} else if mygoui.Button(c, "Enable").Clicked() {
				a.SetPluginEnabled(plugin.ID, true)
			}
			if plugin.UI != nil && plugin.Enabled {
				if a.ActiveUIPlugin() != nil && a.ActiveUIPlugin().ID == plugin.ID {
					mygoui.Text(c, "Active UI").FontSize(11).TextColor(t.Accent)
				} else if mygoui.PrimaryButton(c, "Use as UI").Clicked() {
					a.ActivateUIPlugin(plugin.ID)
				}
			}
			if mygoui.Button(c, "Export ZIP").Clicked() {
				a.ExportPlugin(plugin.ID)
			}
			if mygoui.Button(c, "Remove").Clicked() {
				a.UninstallPlugin(plugin.ID)
			}
		})
	})
}

func (v *view) settings(c *mygoui.Context) {
	t := c.Theme()
	a := v.app
	mygoui.Scroll(c).Grow(1).Children(func() {
		mygoui.Column(c).FillWidth().Padding(20, 24).Gap(10).Children(func() {
			mygoui.Text(c, "Providers and chat models come from the pi-ai catalog. omo stores only your selection, endpoint overrides and credentials.").
				FontSize(12).TextColor(t.TextMuted).Wrap()
			mygoui.Text(c, a.CatalogSummary()).FontSize(11).TextColor(t.TextMuted).Wrap()

			providerField(c, a)
			if a.IsCustomProvider() {
				field(c, "Base URL", &a.DraftBaseURL, false)
			} else {
				mygoui.Column(c).Gap(4).Children(func() {
					mygoui.Text(c, "Base URL").FontSize(12).TextColor(t.TextMuted)
					mygoui.Text(c, a.SelectedProviderBaseURL()).FontSize(12).Selectable().Wrap()
				})
			}

			mygoui.Text(c, "Model").FontSize(12).TextColor(t.TextMuted)
			if a.IsCustomProvider() {
				mygoui.Row(c).Gap(8).AlignItems(mygoui.Center).Children(func() {
					mygoui.TextInput(c, &a.DraftModel).FillWidth()
					label := "Fetch models"
					if a.Fetching {
						label = "Fetching…"
					}
					fetch := mygoui.Button(c, label)
					if a.Fetching {
						fetch.Disabled(true)
					}
					if fetch.Clicked() {
						a.FetchModels()
					}
				})
			} else {
				mygoui.Text(c, a.DraftModel).FontSize(13).Bold()
			}
			if a.IsCustomProvider() && a.FetchNotice != "" {
				mygoui.Text(c, a.FetchNotice).FontSize(11).TextColor(t.TextMuted).Wrap()
			}
			if a.IsCustomProvider() && a.FetchErr != "" {
				mygoui.Text(c, a.FetchErr).FontSize(11).TextColor(t.Danger).Wrap()
			}
			mygoui.TextInput(c, &a.ModelQuery).FillWidth().Placeholder("Filter the pi-ai model catalog")
			modelList := &v.models
			models := a.ProviderModels()
			modelList.Key = func(i int) any { return models[i].ID }
			if len(models) == 0 {
				mygoui.Text(c, "No chat models in this provider's pi-ai catalog.").FontSize(12).TextColor(t.TextMuted)
			} else {
				mygoui.List(c, modelList, len(models), func(i int) {
					m := models[i]
					bg := t.Background
					if m.ID == a.DraftModel {
						bg = t.SurfacePressed
					}
					mygoui.Column(c).
						Padding(6, 9).
						Radius(7).
						Gap(2).
						Background(bg).
						OnClick(func() { a.ChooseModel(m.ID) }).
						Children(func() {
							mygoui.Text(c, m.ID).FontSize(12).Bold().SingleLine()
							detail := m.API
							if m.ContextWindow > 0 {
								detail += fmt.Sprintf(" · %dk context", m.ContextWindow/1000)
							}
							mygoui.Text(c, detail).FontSize(10).TextColor(t.TextMuted)
						})
				}).Height(180).BorderWidth(1).BorderColor(t.Border).Radius(8).Padding(4)
			}

			field(c, "API key for "+a.SelectedProviderName(), &a.DraftKey, true)
			field(c, "Temperature", &a.DraftTemp, false)
			mygoui.Text(c, a.ApiKeyNotice()).FontSize(11).TextColor(t.TextMuted).Wrap()

			mygoui.Divider(c)
			mygoui.Text(c, "Workspace").FontSize(13).Bold()
			mygoui.Text(c, a.WorkspaceLabel()).FontSize(12).TextColor(t.TextMuted).Wrap()
			mygoui.Row(c).Gap(8).Children(func() {
				if mygoui.Button(c, "Choose folder").Clicked() {
					a.ChooseWorkspace()
				}
				if mygoui.PrimaryButton(c, "Save").Clicked() {
					a.SaveSettings()
				}
				if mygoui.Button(c, "Cancel").Clicked() {
					a.ShowSettings = false
				}
			})

			mygoui.Divider(c)
			mygoui.Text(c, fmt.Sprintf("Data: %s", a.DataDir())).FontSize(11).TextColor(t.TextMuted).Selectable()
			mygoui.Text(c, fmt.Sprintf("Runtime: moejs + pi-durable (in-process), transpiled bundle %s", "pi-durable.js")).
				FontSize(11).TextColor(t.TextMuted)
			mygoui.Text(c, fmt.Sprintf("Theme: %s", map[bool]string{true: "dark", false: "light"}[t.Dark])).
				FontSize(11).TextColor(t.TextMuted)
		})
	})
}

func providerField(c *mygoui.Context, a *app.App) {
	t := c.Theme()
	sel := mygoui.SelectBase(c, &a.DraftProvider)
	sel.Trigger.
		FillWidth().
		Padding(8, 10).
		Radius(8).
		BorderWidth(1).
		BorderColor(t.Border).
		Background(t.Surface).
		Children(func() {
			mygoui.Row(c).FillWidth().Gap(8).AlignItems(mygoui.Center).Children(func() {
				mygoui.Text(c, a.SelectedProviderName()).Grow(1)
				mygoui.Text(c, "▾").TextColor(t.TextMuted)
			})
		})
	sel.Popup(func(panel mygoui.Element) {
		panel.Width(420).Padding(4).Radius(10).Background(t.Background).BorderWidth(1).BorderColor(t.Border)
		for _, provider := range a.Providers() {
			item := sel.Item(provider.ID).Padding(6, 10).Radius(6)
			if item.Highlighted() {
				item.Background(t.Accent).TextColor(t.AccentText)
			}
			item.Children(func() {
				mygoui.Row(c).Gap(8).Children(func() {
					mygoui.Text(c, provider.Name).Grow(1)
					mygoui.Text(c, fmt.Sprintf("%d", len(provider.Models))).FontSize(11).TextColor(t.TextMuted)
				})
			})
		}
	})
	a.SyncDraftProvider()
}

func field(c *mygoui.Context, label string, value *string, password bool) {
	t := c.Theme()
	mygoui.Column(c).Gap(4).Children(func() {
		mygoui.Text(c, label).FontSize(12).TextColor(t.TextMuted)
		input := mygoui.TextInput(c, value).FillWidth()
		if password {
			input.Password()
		}
	})
}

// Content returns the window content view.
func Content(a *app.App) *mygoui.Content {
	return mygoui.View(New(a))
}

func (v *view) Value(path string) any {
	a := v.app
	switch path {
	case "app.name":
		return "omo"
	case "workspace":
		return a.WorkspaceLabel()
	case "status":
		return a.Status
	case "activeUi":
		return a.ActiveUIName()
	case "provider":
		return a.Config.Settings.Provider
	case "model":
		return a.Config.Settings.Model
	case "session.title":
		if a.Session != nil {
			return a.Session.Title
		}
		return "New chat"
	case "session.id":
		if a.Session != nil {
			return a.Session.ID
		}
		return ""
	case "sessions":
		items := make([]map[string]any, 0, len(a.Sessions))
		for _, session := range a.Sessions {
			items = append(items, map[string]any{
				"id": session.ID, "title": session.Title, "workspace": filepath.Base(session.Workspace),
			})
		}
		return items
	case "messages":
		items := make([]map[string]any, 0, len(a.Messages))
		for _, message := range a.Messages {
			items = append(items, map[string]any{"role": message.Role, "text": message.Text})
		}
		return items
	case "failure":
		return a.Failure
	default:
		return ""
	}
}

func (v *view) Perform(action, arg string) error {
	a := v.app
	require := func(permission string) error {
		if !a.ActiveUIPluginAllows(permission) {
			return fmt.Errorf("the active UI plugin has not been granted %s", permission)
		}
		return nil
	}
	switch strings.TrimSpace(action) {
	case "", "none":
		return nil
	case "chat.new":
		if err := require("chat.write"); err != nil {
			return err
		}
		a.StartNewChat()
	case "chat.open":
		if err := require("chat.read"); err != nil {
			return err
		}
		if strings.TrimSpace(arg) == "" {
			return fmt.Errorf("chat.open needs a session id")
		}
		a.OpenSession(arg)
	case "chat.send":
		if err := require("chat.write"); err != nil {
			return err
		}
		if strings.TrimSpace(arg) == "" {
			return fmt.Errorf("chat.send needs text")
		}
		a.Send(arg)
	case "chat.stop":
		if err := require("chat.write"); err != nil {
			return err
		}
		a.Stop()
	case "settings.open":
		if err := require("settings.open"); err != nil {
			return err
		}
		a.OpenSettings()
	case "plugins.open":
		a.OpenPlugins()
	case "workspace.choose":
		if err := require("workspace.choose"); err != nil {
			return err
		}
		a.ChooseWorkspace()
	case "ui.builtin":
		a.UseBuiltinUI()
	default:
		return fmt.Errorf("unknown plugin action %q", action)
	}
	return nil
}

func (v *view) Fail(err error) {
	if err == nil {
		return
	}
	v.app.Failure = err.Error()
	v.app.Logf("plugin UI: %v", err)
}

func (v *view) RenderTranscript(c *mygoui.Context) {
	v.transcript(c)
}

func (v *view) RenderComposer(c *mygoui.Context) {
	v.composer(c)
}

func (v *view) RenderSessions(c *mygoui.Context) {
	v.sessionList(c)
}
