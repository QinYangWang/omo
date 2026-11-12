// Package ui renders the MyGo native chat window.
package ui

import (
	"fmt"
	"path/filepath"
	"strings"

	mygoui "github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"

	"github.com/QinYangWang/omo/internal/app"
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
	a := v.app
	mygoui.Column(c).
		Width(240).
		FillHeight().
		Background(t.Surface).
		BorderWidth(0, 1, 0, 0).
		BorderColor(t.Border).
		Padding(12).
		Gap(8).
		Children(func() {
			mygoui.Row(c).Padding(4, 6).Children(func() {
				mygoui.Text(c, "omo").FontSize(15).Bold()
			})
			if mygoui.PrimaryButton(c, "New chat").FillWidth().Clicked() {
				a.StartNewChat()
			}
			v.sessionList(c)

			mygoui.Divider(c)
			mygoui.Text(c, "WORKSPACE").FontSize(10).TextColor(t.TextMuted).Padding(2, 6)
			label := a.WorkspaceLabel()
			mygoui.Text(c, label).FontSize(11).TextColor(t.TextMuted).SingleLine()
			if mygoui.Button(c, "Change directory").FillWidth().Clicked() {
				a.ChooseWorkspace()
			}
			if mygoui.Button(c, "Settings").FillWidth().Clicked() {
				a.OpenSettings()
			}
			if mygoui.Button(c, "Plugins").FillWidth().Clicked() {
				a.OpenPlugins()
			}
		})
}

func (v *view) main(c *mygoui.Context) {
	t := c.Theme()
	a := v.app
	mygoui.Column(c).Grow(1).FillHeight().Children(func() {
		mygoui.Row(c).
			Padding(12, 18).
			Gap(12).
			AlignItems(mygoui.Center).
			BorderWidth(0, 0, 1, 0).
			BorderColor(t.Border).
			Children(func() {
				mygoui.Column(c).Grow(1).Gap(2).Children(func() {
					title := "New chat"
					if a.Session != nil {
						title = a.Session.Title
					}
					mygoui.Text(c, title).FontSize(14).Bold().SingleLine()
					mygoui.Text(c, a.WorkspaceLabel()).FontSize(11).TextColor(t.TextMuted).SingleLine()
				})
				if mygoui.Button(c, "Change directory").Clicked() {
					a.ChooseWorkspace()
				}
			})

		if a.ShowSettings {
			v.settings(c)
			return
		}

		if a.Failure != "" {
			mygoui.Row(c).Padding(10, 18).Background(t.Surface).Children(func() {
				mygoui.Text(c, a.Failure).FontSize(12).TextColor(t.Danger)
			})
		}

		v.transcript(c)
		v.composer(c)
	})
}

func (v *view) sessionList(c *mygoui.Context) {
	t := c.Theme()
	a := v.app
	mygoui.Text(c, "RECENT").FontSize(10).TextColor(t.TextMuted).Padding(6, 6, 0, 6)
	list := &v.sessions
	list.Key = func(i int) any { return a.Sessions[i].ID }
	mygoui.List(c, list, len(a.Sessions), func(i int) {
		s := a.Sessions[i]
		selected := a.Session != nil && a.Session.ID == s.ID
		bg := t.Background
		if selected {
			bg = t.SurfacePressed
		}
		mygoui.Column(c).
			Padding(8, 10).
			Radius(8).
			Gap(2).
			Background(bg).
			OnClick(func() { a.OpenSession(s.ID) }).
			Children(func() {
				mygoui.Text(c, s.Title).FontSize(13).SingleLine()
				mygoui.Text(c, filepath.Base(s.Workspace)).FontSize(11).TextColor(t.TextMuted).SingleLine()
			})
	}).Grow(1)
}

func (v *view) transcript(c *mygoui.Context) {
	t := c.Theme()
	a := v.app
	if len(a.Messages) == 0 && a.Partial == "" && a.Status != "running" && a.Status != "tool" {
		mygoui.Column(c).Grow(1).Padding(28, 24).Gap(10).Children(func() {
			mygoui.Text(c, "How can I help you today?").FontSize(24).Bold()
			mygoui.Text(c, a.WorkspaceLabel()).FontSize(12).TextColor(t.TextMuted).Wrap()
			if !a.HasWorkspace() {
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
	mygoui.List(c, list, rows, func(i int) {
		if i >= len(a.Messages) {
			mygoui.Column(c).MaxWidth(760).Padding(0, 2).Children(func() {
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
					Padding(8, 12).
					Radius(14).
					Background(t.Surface).
					MaxWidth(560)
			})
			return
		}
		mygoui.Column(c).MaxWidth(760).Children(func() {
			markdown.View(c, msg.Text, &v.md)
		})
	}).Grow(1).Padding(16, 20).Gap(14).Justify(mygoui.End).Children(func() {
		if a.Status == "tool" {
			mygoui.Text(c, "Working in the workspace…").FontSize(12).TextColor(t.TextMuted)
		} else if a.Status == "running" && a.Partial == "" {
			mygoui.Row(c).Gap(8).AlignItems(mygoui.Center).Children(func() {
				mygoui.Spinner(c)
				mygoui.Text(c, "Thinking…").FontSize(12).TextColor(t.TextMuted)
			})
		}
	})
}

func (v *view) composer(c *mygoui.Context) {
	t := c.Theme()
	a := v.app
	busy := a.Status == "running" || a.Status == "tool"
	mygoui.Row(c).
		Padding(12, 18).
		Gap(8).
		AlignItems(mygoui.End).
		BorderWidth(1, 0, 0, 0).
		BorderColor(t.Border).
		Children(func() {
			mygoui.TextArea(c, &a.Input).
				Placeholder("Message omo").
				Lines(1, 7).
				Grow(1).
				OnTextKey(func(k mygoui.TextKey) bool {
					if k.Key == mygoui.KeyEnter && k.Mods == 0 {
						text := k.Text()
						k.SetText("")
						a.Send(text)
						return true
					}
					return false
				})
			if busy {
				if mygoui.Button(c, "Stop").Clicked() {
					a.Stop()
				}
			} else if mygoui.PrimaryButton(c, "Send").
				Disabled(strings.TrimSpace(a.Input) == "").
				Clicked() {
				a.Send(a.Input)
			}
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
			mygoui.Row(c).Padding(12, 18).Gap(12).AlignItems(mygoui.Center).
				BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
				mygoui.Column(c).Grow(1).Gap(2).Children(func() {
					mygoui.Text(c, "Plugins").FontSize(16).Bold()
					mygoui.Text(c, "Active UI: "+a.ActiveUIName()).FontSize(11).TextColor(t.TextMuted)
				})
				if mygoui.Button(c, "Back to chat").Clicked() {
					a.ClosePlugins()
				}
			})

			mygoui.Scroll(c).Grow(1).Children(func() {
				mygoui.Column(c).FillWidth().Padding(24).Gap(12).Children(func() {
					mygoui.Text(c, "omo plugins").FontSize(20).Bold()
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
		mygoui.Column(c).FillWidth().Padding(24).Gap(10).Children(func() {
			mygoui.Text(c, "Settings").FontSize(20).Bold()
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
