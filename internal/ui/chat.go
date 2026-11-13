// Package ui renders the MyGo native chat window.
package ui

import (
	"fmt"
	"path/filepath"
	"strings"
	"unicode"

	mygoui "github.com/egoist/mygo/ui"

	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/config"
	"github.com/QinYangWang/omo/internal/plugins"
	moejsruntime "github.com/QinYangWang/omo/internal/runtime/moejs"
)

type view struct {
	app             *app.App
	messages        mygoui.ListState
	sessions        mygoui.ListState
	models          mygoui.ListState
	roster          mygoui.ListState
	plugin          *State
	query           string
	details         bool
	tab             int
	modelOpen       bool
	thinkingOpen    bool
	thinkingWasOpen bool
	thinkingValue   float64
	providerOpen    bool
	providerQuery   string
	addOpen         bool
	addName         string
	addBase         string
	addKey          string
	gallery         bool
	galName         string
	galNotes        string
	galQuery        string
	galTab          int
	galMenu         bool
	galChosen       string
	galValue        float64
}

// New returns the view function for mygo.WindowOptions.Content.
func New(a *app.App) func(*mygoui.Context) {
	v := &view{app: a, plugin: NewState(), details: true}
	return v.build
}

func (v *view) build(c *mygoui.Context) {
	a := v.app
	Apply(c)
	if v.gallery && !a.ShowSettings && !a.ShowPlugins {
		v.galleryPage(c)
		return
	}
	if a.ShowPlugins {
		v.plugins(c)
		return
	}
	if !a.ShowSettings {
		if plugin := a.ActiveUIPlugin(); plugin != nil {
			data, err := a.PluginUIFile(plugin)
			var schema *Node
			if err == nil {
				schema, err = ParseSchema(data)
			}
			if err != nil {
				v.pluginFailure(c, plugin, err)
				return
			}
			Render(c, schema, v.plugin, v)
			return
		}
	}
	t := c.Theme()
	width, _ := c.Size()
	mygoui.Row(c).Fill().Background(t.Background).Children(func() {
		v.rail(c)
		v.sidebar(c)
		v.main(c)
		if v.details && !a.ShowSettings && width >= 1000 {
			v.detailsPanel(c)
		}
	})
}

// rail is the app's icon strip: chat, plugins, settings, and the user at the
// bottom.
func (v *view) rail(c *mygoui.Context) {
	t := c.Theme()
	p := Colors(c)
	a := v.app
	mygoui.Column(c).Width(56).FillHeight().Background(t.Background).
		BorderWidth(0, 1, 0, 0).BorderColor(p.Border).
		Padding(0, 10, 10, 10).Gap(6).AlignItems(mygoui.Center).Children(func() {
		mygoui.Box(c).Height(titleRowHeight(c)).Shrink(0)
		chatActive := !a.ShowSettings && !a.ShowPlugins && !v.gallery
		if IconToggle(c, iconChat, "Chat", chatActive).Clicked() {
			v.gallery = false
			a.ShowSettings = false
			a.ClosePlugins()
		}
		if IconToggle(c, iconGrid, "Plugins", a.ShowPlugins).Clicked() {
			v.gallery = false
			a.OpenPlugins()
		}
		if IconToggle(c, iconLayers, "Components", v.gallery).Clicked() {
			v.gallery = true
			a.ShowSettings = false
			a.ClosePlugins()
		}
		if IconToggle(c, iconSliders, "Settings", a.ShowSettings).Clicked() {
			v.gallery = false
			a.OpenSettings()
		}
		mygoui.Spacer(c)
		if Avatar(c, "You", 28).Clicked() {
			a.ChooseWorkspace()
		}
	})
}

func (v *view) sidebar(c *mygoui.Context) {
	p := Colors(c)
	a := v.app
	mygoui.Column(c).
		Width(SidebarWidth).
		FillHeight().
		Background(p.Rail).
		BorderWidth(0, 1, 0, 0).
		BorderColor(p.Border).
		Children(func() {
			mygoui.Row(c).Height(titleRowHeight(c)).Shrink(0).DragWindow().
				Padding(0, 10, 0, 14).AlignItems(mygoui.Center).Children(func() {
				mygoui.Spacer(c)
				if iconButton(c, iconPlus, "New chat") {
					a.StartNewChat()
				}
			})
			mygoui.Row(c).Padding(0, 12, 8, 12).Children(func() {
				Search(c, &v.query, "Search").FillWidth()
			})
			v.sessionList(c)

			mygoui.Column(c).Padding(10, 10, 10, 10).Gap(6).Children(func() {
				Divider(c)
				who := mygoui.Row(c).FillWidth().Padding(5, 6).Radius(10).Gap(9).AlignItems(mygoui.Center)
				who.Cursor(mygoui.CursorPointer).OnClick(func() { a.ChooseWorkspace() }).
					Tooltip("Change workspace")
				if who.Hovered() {
					who.Background(p.RailHover)
				}
				who.Children(func() {
					mygoui.Icon(c, iconFolder).FontSize(15).TextColor(p.Muted)
					mygoui.Column(c).Grow(1).Gap(1).Children(func() {
						mygoui.Text(c, workspaceName(a)).FontSize(12.5).Bold().SingleLine()
						mygoui.Text(c, "Workspace").FontSize(11).TextColor(p.Muted).SingleLine()
					})
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

// iconButton is a borderless square button showing an icon only.
func iconButton(c *mygoui.Context, ic *mygoui.SVG, label string) bool {
	return IconButton(c, ic, label)
}

// botFace draws a Bot's generated agent avatar, moving while it works.
func botFace(c *mygoui.Context, name string, size float32, working bool) mygoui.Element {
	state := AgentIdle
	if working {
		state = AgentWorking
	}
	return AgentAvatar(c, name, size, state)
}

func (v *view) main(c *mygoui.Context) {
	t := c.Theme()
	a := v.app
	mygoui.Column(c).Grow(1).FillHeight().Background(t.Background).Children(func() {
		if a.ShowSettings {
			v.headerBar(c, "Settings", "", func() {
				if iconButton(c, iconArrowLeft, "Back to chat") {
					a.ShowSettings = false
				}
			})
			v.settings(c)
			return
		}

		v.chatHeader(c)
		if a.Failure != "" {
			v.banner(c, a.Failure)
		}
		v.transcript(c)
		v.composer(c)
	})
}

// chatHeader is the conversation's title row: who you are talking to, a new
// chat action and, while the details panel is closed, its toggle.
func (v *view) chatHeader(c *mygoui.Context) {
	p := Colors(c)
	a := v.app
	bar := c.TitleBar()
	right := float32(18)
	if !v.details {
		right = max(bar.Right, 18)
	}
	row := mygoui.Row(c).Height(titleRowHeight(c)).Shrink(0).
		Padding(0, right, 0, 16).
		Gap(6).AlignItems(mygoui.Center).DragWindow().
		BorderWidth(0, 0, 1, 0).BorderColor(p.Border)
	row.Children(func() {
		name := v.pageTitle()
		mygoui.Text(c, name).FontSize(15).Bold().SingleLine()
		if a.Session != nil {
			mygoui.Text(c, roleLabel(a.Session.Role)).FontSize(11).TextColor(p.Muted).
				Padding(2, 6).Radius(5).Background(p.RailHover).SingleLine()
		}
		mygoui.Spacer(c)
		if !v.details {
			if IconToggle(c, iconPanelRight, "Details", false).Clicked() {
				v.details = true
			}
		}
	})
}

// roleLabel names a Bot's role in the team.
func roleLabel(role string) string {
	if role == "main" {
		return "Team lead"
	}
	return "Member"
}

// titleRowHeight is the room the window controls take, so a header's content
// lines up with them.
func titleRowHeight(c *mygoui.Context) float32 {
	bar := c.TitleBar()
	return max(bar.Height, bar.Bottom, 44)
}

// detailsPanel is the right column: the team library and its members.
func (v *view) detailsPanel(c *mygoui.Context) {
	p := Colors(c)
	bar := c.TitleBar()
	mygoui.Column(c).Width(DetailsWidth).FillHeight().
		BorderWidth(0, 0, 0, 1).BorderColor(p.Border).
		Background(p.Rail).Children(func() {
		mygoui.Row(c).Height(titleRowHeight(c)).Shrink(0).DragWindow().
			Padding(0, max(bar.Right, 18), 0, 18).AlignItems(mygoui.Center).Children(func() {
			mygoui.Text(c, "Details").FontSize(15).Bold().Grow(1)
			if IconToggle(c, iconPanelClose, "Close details", true).Clicked() {
				v.details = false
			}
		})
		mygoui.Column(c).FillWidth().Padding(0, 14, 10, 14).Children(func() {
			Segmented(c, &v.tab, []string{"Library", "Members"})
		})
		if v.tab == 1 {
			v.members(c)
		} else {
			v.library(c)
		}
	})
}

func (v *view) members(c *mygoui.Context) {
	p := Colors(c)
	a := v.app
	roster := a.Sessions
	list := &v.roster
	list.Key = func(i int) any {
		if i >= len(roster) {
			return "add"
		}
		return roster[i].ID
	}
	mygoui.List(c, list, len(roster)+1, func(i int) {
		if i >= len(roster) {
			add := mygoui.Row(c).Padding(6, 4).Radius(9).Gap(10).AlignItems(mygoui.Center)
			add.Cursor(mygoui.CursorPointer).OnClick(func() { a.AddMember() })
			if add.Hovered() {
				add.Background(p.RailHover)
			}
			add.Children(func() {
				mygoui.Box(c).Size(30, 30).Radius(15).AlignItems(mygoui.Center).
					Justify(mygoui.Center).Children(func() {
					mygoui.Icon(c, iconPlus).FontSize(14).TextColor(p.Muted)
				})
				mygoui.Text(c, "Add a member").FontSize(12.5).TextColor(p.Muted)
			})
			return
		}
		member := roster[i]
		row := mygoui.Row(c).Padding(6, 4).Radius(9).Gap(10).AlignItems(mygoui.Center)
		row.Cursor(mygoui.CursorPointer).OnClick(func() { a.OpenSession(member.ID) })
		if row.Hovered() {
			row.Background(p.RailHover)
		}
		row.Children(func() {
			botFace(c, member.Title, 30, member.Status == "running" || member.Status == "tool")
			mygoui.Text(c, member.Title).FontSize(12.5).SingleLine().Grow(1)
			if member.Status == "running" || member.Status == "tool" {
				mygoui.Spinner(c)
			}
		})
	}).Grow(1).Padding(0, 14, 0, 14).Gap(2)
}

func (v *view) library(c *mygoui.Context) {
	p := Colors(c)
	a := v.app
	mygoui.Column(c).Padding(4, 14).Gap(12).Children(func() {
		v.detailField(c, "Model", a.Config.Settings.Model)
		v.detailField(c, "Thinking", a.ActiveThinkingLevel())
		v.detailField(c, "Provider", a.SelectedProviderName())
		v.detailField(c, "Team workspace", a.WorkspaceLabel())
		v.detailField(c, "Bot folder", a.ActiveFolder())
		mygoui.Row(c).Gap(8).Wrap().Children(func() {
			if Button(c, "Change folder", ButtonProps{}).Clicked() {
				a.ChooseBotFolder()
			}
			if Button(c, "Use team workspace", ButtonProps{}).Clicked() {
				a.ResetBotFolder()
			}
		})
		if a.LastRun != nil {
			v.detailField(c, "Last turn", fmt.Sprintf("%s · %d steps", a.LastRun.Agent, a.LastRun.Steps))
		}
		mygoui.Text(c, "The Bot's tools run in its folder; attached files are copied to .omo/uploads in the Bot folder.").
			FontSize(11).TextColor(p.Muted).Wrap()
	})
}

func (v *view) detailField(c *mygoui.Context, label, value string) {
	p := Colors(c)
	if value == "" {
		value = "Not set"
	}
	mygoui.Column(c).Gap(3).Children(func() {
		mygoui.Text(c, label).FontSize(10.5).TextColor(p.Muted)
		mygoui.Text(c, value).FontSize(12).Wrap()
	})
}

// headerBar draws a page's draggable title row and the actions at its end.
func (v *view) headerBar(c *mygoui.Context, title, subtitle string, actions func()) {
	p := Colors(c)
	row := mygoui.Row(c).Height(titleRowHeight(c)).Shrink(0).
		Padding(0, max(c.TitleBar().Right, 18), 0, 16).
		Gap(8).AlignItems(mygoui.Center).DragWindow().
		BorderWidth(0, 0, 1, 0).BorderColor(p.Border)
	row.Children(func() {
		mygoui.Column(c).Grow(1).Gap(1).Children(func() {
			mygoui.Text(c, title).FontSize(15).Bold().SingleLine()
			if subtitle != "" {
				mygoui.Text(c, subtitle).FontSize(11).TextColor(p.Muted).SingleLine()
			}
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

// railNote is a Bot's short activity note for the rail.
func railNote(status string) string {
	switch status {
	case "running":
		return "typing…"
	case "tool":
		return "working…"
	case "error":
		return "failed"
	}
	return ""
}

func (v *view) sessionList(c *mygoui.Context) {
	p := Colors(c)
	a := v.app
	rows := a.Sessions
	if q := strings.ToLower(strings.TrimSpace(v.query)); q != "" {
		matched := make([]app.SessionView, 0, len(rows))
		for _, s := range rows {
			if strings.Contains(strings.ToLower(s.Title), q) ||
				strings.Contains(strings.ToLower(s.Preview), q) {
				matched = append(matched, s)
			}
		}
		rows = matched
	}
	if len(rows) == 0 {
		mygoui.Text(c, "No conversations yet").FontSize(11).TextColor(p.Muted).Padding(4, 14, 8, 14)
		return
	}
	list := &v.sessions
	list.Key = func(i int) any { return rows[i].ID }
	mygoui.List(c, list, len(rows), func(i int) {
		s := rows[i]
		selected := a.Session != nil && a.Session.ID == s.ID
		item := mygoui.Row(c).Padding(8, 14, 8, 12).Radius(12).Gap(10).AlignItems(mygoui.Center)
		if selected {
			item.Background(p.Card)
		} else if item.Hovered() {
			item.Background(p.RailHover)
		}
		item.Cursor(mygoui.CursorPointer).OnClick(func() { a.OpenSession(s.ID) }).Children(func() {
			botFace(c, s.Title, 38, s.Status == "running" || s.Status == "tool")
			mygoui.Column(c).Grow(1).Gap(2).Children(func() {
				mygoui.Row(c).Gap(6).AlignItems(mygoui.Center).Children(func() {
					mygoui.Text(c, s.Title).FontSize(13).Bold().SingleLine()
					mygoui.Text(c, roleLabel(s.Role)).FontSize(10).TextColor(p.Muted).
						Padding(2, 5).Radius(4).Background(p.RailHover).SingleLine()
					mygoui.Spacer(c)
					mygoui.Text(c, railNote(s.Status)).FontSize(10.5).TextColor(p.Muted).SingleLine()
				})
				preview := s.Preview
				if preview == "" {
					preview = "No messages yet"
				}
				mygoui.Text(c, preview).FontSize(11.5).TextColor(p.Muted).SingleLine()
			})
		})
	}).Grow(1).Padding(0, 6, 0, 6).Gap(2)
}

func (v *view) transcript(c *mygoui.Context) {
	p := Colors(c)
	a := v.app
	if len(a.Messages) == 0 && a.Partial == "" && a.Status != "running" && a.Status != "tool" {
		mygoui.Column(c).Grow(1).Justify(mygoui.Center).Padding(24, 36).Gap(10).Children(func() {
			mygoui.Text(c, "How can I help you today?").FontSize(24).Bold()
			if a.HasWorkspace() {
				mygoui.Text(c, "Working in "+workspaceName(a)).FontSize(12).TextColor(p.Muted).Wrap()
			} else {
				mygoui.Text(c, "Choose a folder to start.").FontSize(12).TextColor(p.Muted).Wrap()
				if Button(c, "Choose a workspace", ButtonProps{Primary: true}).AlignSelf(mygoui.Start).Clicked() {
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
	name := v.pageTitle()
	render := func(i int) {
		if i == 0 {
			mygoui.Column(c).FillWidth().Gap(14).Children(func() {
				mygoui.Row(c).FillWidth().Justify(mygoui.Center).Children(func() {
					mygoui.Text(c, "Today").FontSize(11).TextColor(p.Muted)
				})
				v.messageRow(c, i, name)
			})
			return
		}
		v.messageRow(c, i, name)
	}
	mygoui.List(c, list, rows, render).Grow(1).Padding(18, 26, 8, 26).Gap(14).Justify(mygoui.End).Children(func() {
		if a.Status == "tool" {
			mygoui.Text(c, "Working in the workspace…").FontSize(12).TextColor(p.Muted)
		} else if a.Status == "running" && a.Partial == "" {
			mygoui.Row(c).Gap(8).AlignItems(mygoui.Center).Children(func() {
				mygoui.Spinner(c)
				mygoui.Text(c, "Thinking…").FontSize(12).TextColor(p.Muted)
			})
		}
	})
}

// messageRow is one transcript line: your message in a light bubble on the
// right, a Bot's in a dark bubble with its avatar on the left.
func (v *view) messageRow(c *mygoui.Context, i int, name string) {
	p := Colors(c)
	a := v.app
	if i >= len(a.Messages) {
		mygoui.Row(c).FillWidth().Gap(10).AlignItems(mygoui.Start).Children(func() {
			botFace(c, name, 30, true)
			mygoui.Column(c).Gap(5).MaxWidth(620).Children(func() {
				mygoui.Text(c, name).FontSize(12).TextColor(p.Muted)
				mygoui.Column(c).Padding(11, 15).Radius(18).Background(p.Bubble).Children(func() {
					Markdown(c, a.Partial, MarkdownProps{Animated: true})
				})
			})
		})
		return
	}
	msg := a.Messages[i]
	if msg.Role == "user" {
		mygoui.Row(c).FillWidth().Children(func() {
			mygoui.Spacer(c)
			mygoui.Column(c).Padding(11, 15).Radius(18).Background(p.User).
				MaxWidth(560).Children(func() {
				mygoui.RichText(c, mentionSpans(msg.Text, p.Mention)...).
					TextColor(p.UserText).Selectable()
			})
		})
		return
	}
	mygoui.Row(c).FillWidth().Gap(10).AlignItems(mygoui.Start).Children(func() {
		botFace(c, name, 30, false)
		mygoui.Column(c).Gap(5).MaxWidth(620).Children(func() {
			mygoui.Text(c, name).FontSize(12).TextColor(p.Muted)
			mygoui.Column(c).Padding(11, 15).Radius(18).Background(p.Bubble).Children(func() {
				Markdown(c, msg.Text, MarkdownProps{})
			})
		})
	})
}

// mentionSpans colors @names inside a bubble.
func mentionSpans(text string, color mygoui.Color) []mygoui.Span {
	spans := make([]mygoui.Span, 0, 8)
	var word strings.Builder
	flush := func() {
		if word.Len() == 0 {
			return
		}
		span := mygoui.Span{Text: word.String()}
		if strings.HasPrefix(span.Text, "@") && len(span.Text) > 1 {
			span.Color = color
		}
		spans = append(spans, span)
		word.Reset()
	}
	for _, r := range text {
		if unicode.IsSpace(r) {
			flush()
			word.WriteRune(r)
			flush()
			continue
		}
		word.WriteRune(r)
	}
	flush()
	return spans
}

func (v *view) composer(c *mygoui.Context) {
	t := c.Theme()
	p := Colors(c)
	a := v.app
	busy := a.Status == "running" || a.Status == "tool"
	empty := strings.TrimSpace(a.Input) == "" && len(a.Attachments) == 0
	mygoui.Row(c).FillWidth().Justify(mygoui.Center).Padding(6, 20, 16, 20).Children(func() {
		card := mygoui.Column(c).MaxWidth(860).Grow(1).Radius(14).Background(t.Surface).
			Border(1, p.Border).Padding(6).Gap(4)
		card.Children(func() {
			if len(a.Attachments) > 0 {
				mygoui.Row(c).Wrap().Gap(6).Padding(2).Children(func() {
					for i, attachment := range a.Attachments {
						v.attachmentChip(c, i, attachment)
					}
				})
			}
			mygoui.Row(c).Gap(4).AlignItems(mygoui.End).Children(func() {
				attach := mygoui.ButtonBase(c).Size(28, 28).Radius(8).Label("Attach files")
				attach.AlignItems(mygoui.Center).Justify(mygoui.Center).Tooltip("Attach files")
				if attach.Hovered() {
					attach.Background(p.RailHover)
				}
				if attach.Clicked() {
					a.AttachFiles()
				}
				attach.Children(func() { mygoui.Icon(c, iconPlus).FontSize(15).TextColor(p.Muted) })
				mygoui.TextAreaBase(c, &a.Input).
					Placeholder("Write a message…").
					Lines(1, 6).
					FontSize(13).
					Padding(4, 6).
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
				v.modelPicker(c, busy)
				v.thinkingPicker(c, busy)
				if busy {
					stop := mygoui.ButtonBase(c).Size(28, 28).Radius(8).Label("Stop")
					stop.Background(p.Card).AlignItems(mygoui.Center).Justify(mygoui.Center)
					if stop.Hovered() {
						stop.Background(p.Border)
					}
					if stop.Clicked() {
						a.Stop()
					}
					stop.Children(func() { mygoui.Icon(c, iconStop).FontSize(14).TextColor(p.Text) })
					return
				}
				send := mygoui.ButtonBase(c).Size(28, 28).Radius(8).Label("Send")
				send.AlignItems(mygoui.Center).Justify(mygoui.Center)
				send.Disabled(empty)
				send.Background(p.Text)
				iconColor := t.Background
				if empty {
					send.Background(t.Border)
					iconColor = p.Muted
				}
				send.Children(func() { mygoui.Icon(c, iconArrowUp).FontSize(15).TextColor(iconColor) })
				if send.Clicked() {
					a.Send(a.Input)
				}
			})
		})
	})
}

// attachmentChip is one attached file above the composer's controls.
func (v *view) attachmentChip(c *mygoui.Context, index int, attachment app.Attachment) {
	p := Colors(c)
	a := v.app
	chip := mygoui.Row(c).Height(26).Padding(0, 4, 0, 8).Radius(8).Gap(6).
		AlignItems(mygoui.Center).Background(p.RailHover)
	chip.Children(func() {
		mygoui.Icon(c, iconFile).FontSize(12).TextColor(p.Muted)
		mygoui.Text(c, attachment.Name).FontSize(11.5).TextColor(p.Text).SingleLine().MaxWidth(160)
		remove := mygoui.ButtonBase(c).Size(20, 20).Radius(5).Label("Remove " + attachment.Name)
		remove.AlignItems(mygoui.Center).Justify(mygoui.Center)
		if remove.Hovered() {
			remove.Background(p.Border)
		}
		if remove.Clicked() {
			a.DetachFile(index)
		}
		remove.Children(func() { mygoui.Icon(c, iconX).FontSize(10).TextColor(p.Muted) })
	})
}

// modelPicker is the composer's model menu: the model in use and every model
// of the current provider, as Lobe's dropdown.
func (v *view) modelPicker(c *mygoui.Context, busy bool) {
	p := Colors(c)
	a := v.app
	if busy {
		// Switching reopens the team, which must not happen mid-turn.
		return
	}
	name := a.Config.Settings.Model
	if name == "" {
		name = "Model"
	}
	models := a.ChatModels()
	items := make([]MenuItem, 0, len(models)+1)
	for _, model := range models {
		items = append(items, MenuItem{Key: model.ID, Label: model.ID, Extra: model.API})
	}
	if len(items) == 0 {
		items = append(items, MenuItem{Key: "", Label: "No models in this provider", Disabled: true})
	}
	chosen := DropdownMenu(c, &v.modelOpen, items, func(t mygoui.Element) {
		chip := t.Row().Height(28).PaddingX(8).Gap(6).AlignItems(mygoui.Center).
			Radius(8).FontSize(12).TextColor(p.Muted).Cursor(mygoui.CursorPointer).Label("Choose model")
		if chip.Hovered() || v.modelOpen {
			chip.Background(p.RailHover).TextColor(p.Text)
		}
		chip.Children(func() {
			mygoui.Text(c, name).MaxWidth(200).SingleLine()
			mygoui.Icon(c, iconChevron).FontSize(12)
		})
	})
	if chosen != "" {
		a.SwitchModel(chosen)
	}
}

// thinkingPicker is the composer's reasoning-level control: a compact effort
// slider, as mygo's effort-slider example, over the levels the model supports.
// It commits when the panel closes so dragging does not reopen the team on
// every step.
func (v *view) thinkingPicker(c *mygoui.Context, busy bool) {
	p := Colors(c)
	a := v.app
	levels := a.ActiveThinkingLevels()
	if len(levels) <= 1 || busy {
		return
	}
	current := a.ActiveThinkingLevel()
	if !v.thinkingOpen {
		v.thinkingValue = float64(app.ThinkingIndex(current, levels))
	}
	idx := int(v.thinkingValue)
	if idx < 0 {
		idx = 0
	}
	if idx >= len(levels) {
		idx = len(levels) - 1
	}
	shown := levels[idx]
	chip := mygoui.ButtonBase(c).Height(28).Padding(0, 8).Radius(8).Gap(6).
		AlignItems(mygoui.Center).Label("Thinking level")
	if chip.Hovered() || v.thinkingOpen {
		chip.Background(p.RailHover)
	}
	chip.Children(func() {
		mygoui.Text(c, shown).FontSize(12).TextColor(p.Muted).SingleLine()
		mygoui.Icon(c, iconChevron).FontSize(11).TextColor(p.Muted)
	})
	Popover(c, chip, &v.thinkingOpen, func() {
		mygoui.Column(c).Width(240).Gap(8).Children(func() {
			mygoui.Row(c).AlignItems(mygoui.Center).Children(func() {
				mygoui.Text(c, "Thinking").FontSize(13).Bold().Grow(1)
				mygoui.Text(c, shown).FontSize(12).TextColor(p.Muted).SingleLine()
			})
			StepSlider(c, &v.thinkingValue, 0, float64(len(levels)-1), 1)
			mygoui.Row(c).Children(func() {
				mygoui.Text(c, "Faster").FontSize(10).TextColor(p.Muted).Grow(1)
				mygoui.Text(c, "Smarter").FontSize(10).TextColor(p.Muted)
			})
		})
	})
	if !v.thinkingOpen && v.thinkingWasOpen && shown != current {
		a.SetThinking(shown)
	}
	v.thinkingWasOpen = v.thinkingOpen
}

func (v *view) pluginFailure(c *mygoui.Context, plugin *plugins.Installed, err error) {
	t := c.Theme()
	mygoui.Column(c).Fill().Padding(24).Gap(12).Background(t.Background).Children(func() {
		mygoui.Text(c, "UI plugin failed").FontSize(20).Bold()
		mygoui.Text(c, plugin.Name).FontSize(14).TextColor(t.TextMuted)
		mygoui.Text(c, err.Error()).FontSize(12).TextColor(t.Danger).Wrap()
		mygoui.Row(c).Gap(8).Children(func() {
			if Button(c, "Use built-in UI", ButtonProps{Primary: true}).Clicked() {
				v.app.UseBuiltinUI()
			}
			if Button(c, "Plugins", ButtonProps{}).Clicked() {
				v.app.OpenPlugins()
			}
		})
	})
}

func (v *view) plugins(c *mygoui.Context) {
	t := c.Theme()
	a := v.app
	mygoui.Row(c).Fill().Background(t.Background).Children(func() {
		v.rail(c)
		v.sidebar(c)
		mygoui.Column(c).Grow(1).FillHeight().Children(func() {
			v.headerBar(c, "Plugins", "", func() {
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

					Divider(c)
					mygoui.Row(c).Gap(8).AlignItems(mygoui.Center).Wrap().Children(func() {
						mygoui.Text(c, "Add a plugin").FontSize(15).Bold().Grow(1)
						if Button(c, "Install folder", ButtonProps{}).Clicked() {
							a.InstallPluginFolder()
						}
						if Button(c, "Install ZIP", ButtonProps{Primary: true}).Clicked() {
							a.InstallPluginZip()
						}
					})

					mygoui.Row(c).Gap(8).AlignItems(mygoui.Center).Children(func() {
						mygoui.Text(c, "Installed").FontSize(15).Bold().Grow(1)
						if Button(c, "Use built-in UI", ButtonProps{}).Clicked() {
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

					Divider(c)
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
				if Button(c, "Disable", ButtonProps{}).Clicked() {
					a.SetPluginEnabled(plugin.ID, false)
				}
			} else if Button(c, "Enable", ButtonProps{}).Clicked() {
				a.SetPluginEnabled(plugin.ID, true)
			}
			if plugin.UI != nil && plugin.Enabled {
				if a.ActiveUIPlugin() != nil && a.ActiveUIPlugin().ID == plugin.ID {
					mygoui.Text(c, "Active UI").FontSize(11).TextColor(t.Accent)
				} else if Button(c, "Use as UI", ButtonProps{Primary: true}).Clicked() {
					a.ActivateUIPlugin(plugin.ID)
				}
			}
			if Button(c, "Export ZIP", ButtonProps{}).Clicked() {
				a.ExportPlugin(plugin.ID)
			}
			if Button(c, "Remove", ButtonProps{}).Clicked() {
				a.UninstallPlugin(plugin.ID)
			}
		})
	})
}

func (v *view) settings(c *mygoui.Context) {
	if v.providerOpen {
		v.providerEditor(c)
		return
	}
	t := c.Theme()
	a := v.app
	p := Colors(c)
	mygoui.Scroll(c).Grow(1).Children(func() {
		mygoui.Column(c).FillWidth().Padding(20, 24).Gap(12).Children(func() {
			mygoui.Text(c, "Providers and chat models come from the pi-ai catalog. omo stores only credentials, endpoints and your selection.").
				FontSize(12).TextColor(p.Muted).Wrap()
			mygoui.Text(c, "Appearance").FontSize(13).Bold()
			appearance := app.AppearanceIndex(a.Config.Settings.Appearance)
			mygoui.Row(c).FillWidth().Children(func() {
				Segmented(c, &appearance, []string{"System", "Light", "Dark"}).FillWidth()
			})
			if value := config.Appearances[appearance]; value != a.Config.Settings.Appearance {
				a.SetAppearance(value)
			}
			Input(c, &v.providerQuery, "Search providers").FillWidth()

			mygoui.Text(c, "Configured").FontSize(13).Bold()
			configured := a.ConfiguredProviders()
			if len(configured) == 0 {
				mygoui.Text(c, "No provider is set up yet. Add one below.").FontSize(11).TextColor(p.Muted)
			}
			mygoui.Row(c).Wrap().Gap(10).Children(func() {
				for _, provider := range configured {
					v.providerCard(c, provider, true)
				}
				v.addProviderCard(c)
			})

			mygoui.Text(c, "Add provider").FontSize(13).Bold()
			query := strings.ToLower(strings.TrimSpace(v.providerQuery))
			listed := 0
			mygoui.Row(c).Wrap().Gap(10).Children(func() {
				for _, provider := range a.Providers() {
					if a.ProviderHasKey(provider.ID) || a.IsCustomProviderID(provider.ID) {
						continue
					}
					if query != "" && !strings.Contains(strings.ToLower(provider.Name+" "+provider.ID), query) {
						continue
					}
					v.providerCard(c, provider, false)
					listed++
				}
			})
			if listed == 0 {
				mygoui.Text(c, "No other provider matches.").FontSize(11).TextColor(p.Muted)
			}

			Divider(c)
			mygoui.Row(c).Gap(8).Children(func() {
				if Button(c, "Close", ButtonProps{}).Clicked() {
					a.ShowSettings = false
				}
			})
			mygoui.Text(c, fmt.Sprintf("Data: %s", a.DataDir())).FontSize(11).TextColor(p.Muted).Selectable()
		})
	})
	if v.addOpen {
		mygoui.Modal(c, &v.addOpen, func() {
			mygoui.Column(c).Width(460).Padding(20).Gap(10).Radius(14).
				Background(t.Surface).Border(1, p.Border).Children(func() {
				Heading(c, "Add provider", 17)
				mygoui.Text(c, "An OpenAI-compatible endpoint. Its models come from the endpoint, so omo assumes none.").
					FontSize(11).TextColor(p.Muted).Wrap()
				field(c, "Name", &v.addName, false)
				field(c, "Base URL", &v.addBase, false)
				field(c, "API key", &v.addKey, true)
				mygoui.Row(c).Gap(8).Justify(mygoui.End).Children(func() {
					if Button(c, "Cancel", ButtonProps{}).Clicked() {
						v.addOpen = false
					}
					if Button(c, "Add", ButtonProps{Primary: true}).Clicked() {
						if err := a.AddCustomProvider(v.addName, v.addBase, v.addKey); err != nil {
							a.Failure = err.Error()
							return
						}
						v.addName, v.addBase, v.addKey = "", "", ""
						v.addOpen = false
						v.providerOpen = true
					}
				})
			})
		})
	}
}

// providerCard is one provider as a card; clicking it opens its form.
func (v *view) providerCard(c *mygoui.Context, provider moejsruntime.CatalogProvider, configured bool) {
	t := c.Theme()
	p := Colors(c)
	a := v.app
	card := mygoui.Column(c).Width(248).Padding(12).Gap(6).Radius(12).Border(1, p.Border).
		Background(t.Surface)
	card.Cursor(mygoui.CursorPointer)
	if card.Hovered() {
		card.Background(p.RailHover)
	}
	card.OnClick(func() {
		a.ChooseProvider(provider.ID)
		v.providerOpen = true
	})
	card.Children(func() {
		mygoui.Row(c).Gap(8).AlignItems(mygoui.Center).Children(func() {
			mygoui.Text(c, provider.Name).FontSize(13.5).Bold().SingleLine().Grow(1)
			if configured {
				mygoui.Box(c).Size(6, 6).Radius(3).Background(t.Success)
			}
		})
		summary := fmt.Sprintf("%d models", len(provider.Models))
		if len(provider.Models) == 1 {
			summary = "1 model"
		}
		if len(provider.Models) == 0 {
			summary = "No models yet"
		}
		if configured {
			if hint := a.ProviderKeyHint(provider.ID); hint != "" {
				summary = hint + " · " + summary
			}
		}
		mygoui.Text(c, summary).FontSize(11).TextColor(p.Muted).SingleLine()
	})
}

// addProviderCard is the "+" card that opens the add-provider dialog.
func (v *view) addProviderCard(c *mygoui.Context) {
	t := c.Theme()
	p := Colors(c)
	card := mygoui.Column(c).Width(248).Padding(12).Gap(6).Radius(12).
		Border(1, p.Border).Background(t.Surface)
	card.Cursor(mygoui.CursorPointer)
	if card.Hovered() {
		card.Background(p.RailHover)
	}
	card.OnClick(func() { v.addOpen = true })
	card.Children(func() {
		mygoui.Row(c).Gap(8).AlignItems(mygoui.Center).Children(func() {
			mygoui.Icon(c, iconPlus).FontSize(15).TextColor(p.Muted)
			mygoui.Text(c, "Add provider").FontSize(13).Bold().Grow(1)
		})
		mygoui.Text(c, "Name, base URL and API key").FontSize(11).TextColor(p.Muted).SingleLine()
	})
}

// providerEditor is the form for one provider: endpoint, key and the model.
func (v *view) providerEditor(c *mygoui.Context) {
	t := c.Theme()
	p := Colors(c)
	a := v.app
	custom := a.IsCustomProvider()
	mygoui.Scroll(c).Grow(1).Children(func() {
		mygoui.Column(c).FillWidth().Padding(20, 24).Gap(10).Children(func() {
			mygoui.Row(c).Gap(8).AlignItems(mygoui.Center).Children(func() {
				if IconButton(c, iconArrowLeft, "Back to providers") {
					v.providerOpen = false
				}
				Heading(c, a.SelectedProviderName(), 16)
				if custom {
					mygoui.Text(c, "custom endpoint").FontSize(11).TextColor(p.Muted)
				}
			})
			mygoui.Text(c, "ID: "+a.DraftProvider).FontSize(11).TextColor(p.Muted).Selectable()

			if custom {
				field(c, "Base URL", &a.DraftBaseURL, false)
			} else {
				mygoui.Column(c).Gap(4).Children(func() {
					mygoui.Text(c, "Base URL").FontSize(12).TextColor(p.Muted)
					mygoui.Text(c, a.SelectedProviderBaseURL()).FontSize(12).Selectable().Wrap()
				})
			}
			field(c, "API key", &a.DraftKey, true)
			if a.ProviderHasKey(a.DraftProvider) {
				mygoui.Row(c).Gap(8).Wrap().Children(func() {
					if Button(c, "Remove key", ButtonProps{}).Clicked() {
						a.RemoveProviderKey(a.DraftProvider)
					}
				})
			}
			mygoui.Text(c, a.ApiKeyNotice()).FontSize(11).TextColor(p.Muted).Wrap()

			Divider(c)
			mygoui.Text(c, "Model").FontSize(13).Bold()
			if custom {
				mygoui.Row(c).Gap(8).AlignItems(mygoui.Center).Children(func() {
					Input(c, &a.DraftModel, "Model ID").FillWidth()
					label := "Fetch models"
					if a.Fetching {
						label = "Fetching…"
					}
					fetch := Button(c, label, ButtonProps{})
					if a.Fetching {
						fetch.Disabled(true)
					}
					if fetch.Clicked() {
						a.FetchModels()
					}
				})
				mygoui.Text(c, "Save adds the model ID to this provider; Fetch replaces the list with the endpoint's.").
					FontSize(11).TextColor(p.Muted).Wrap()
			} else {
				mygoui.Text(c, a.DraftModel).FontSize(13).Bold().SingleLine()
			}
			if a.FetchNotice != "" {
				mygoui.Text(c, a.FetchNotice).FontSize(11).TextColor(p.Muted).Wrap()
			}
			if a.FetchErr != "" {
				mygoui.Text(c, a.FetchErr).FontSize(11).TextColor(t.Danger).Wrap()
			}
			modelField(c, a, &v.models)

			Divider(c)
			mygoui.Text(c, "Workspace").FontSize(13).Bold()
			mygoui.Text(c, a.WorkspaceLabel()).FontSize(12).TextColor(p.Muted).Wrap()
			mygoui.Row(c).Gap(8).Wrap().Children(func() {
				if Button(c, "Choose folder", ButtonProps{}).Clicked() {
					a.ChooseWorkspace()
				}
				if Button(c, "Save", ButtonProps{Primary: true}).Clicked() {
					v.providerOpen = false
					a.SaveSettings()
				}
				if Button(c, "Cancel", ButtonProps{}).Clicked() {
					v.providerOpen = false
					a.ShowSettings = false
				}
				if custom {
					if Button(c, "Remove provider", ButtonProps{}).Clicked() {
						v.providerOpen = false
						a.RemoveCustomProvider(a.DraftProvider)
					}
				}
			})
		})
	})
}

func modelField(c *mygoui.Context, a *app.App, list *mygoui.ListState) {
	t := c.Theme()
	Input(c, &a.ModelQuery, "Filter models").FillWidth()
	models := a.ProviderModels()
	list.Key = func(i int) any { return models[i].ID }
	if len(models) == 0 {
		mygoui.Text(c, "No chat models in this provider's pi-ai catalog.").FontSize(12).TextColor(t.TextMuted)
		return
	}
	listEl := mygoui.List(c, list, len(models), func(i int) {
		m := models[i]
		row := mygoui.Column(c).Padding(6, 9).Radius(7).Gap(2)
		if m.ID == a.DraftModel {
			row.Background(t.SurfacePressed)
		} else if row.Hovered() {
			row.Background(t.SurfaceHover)
		}
		row.OnClick(func() { a.ChooseModel(m.ID) }).Children(func() {
			mygoui.Text(c, m.ID).FontSize(12).Bold().SingleLine()
			detail := m.API
			if m.ContextWindow > 0 {
				detail += fmt.Sprintf(" · %dk context", m.ContextWindow/1000)
			}
			mygoui.Text(c, detail).FontSize(10).TextColor(t.TextMuted)
		})
	})
	height := float32(len(models)*48 + 8)
	if height > 220 {
		height = 220
	}
	listEl.Height(height).BorderWidth(1).BorderColor(t.Border).Radius(8).Padding(4)
}

func field(c *mygoui.Context, label string, value *string, password bool) {
	t := c.Theme()
	mygoui.Column(c).Gap(4).Children(func() {
		mygoui.Text(c, label).FontSize(12).TextColor(t.TextMuted)
		input := Input(c, value, "").FillWidth()
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
