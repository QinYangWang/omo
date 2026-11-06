package view

import (
	"time"

	"github.com/QinYangWang/omo/internal/agent"
	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/kit"
	"github.com/egoist/mygo/ui"
)

// homeScreen is the new-session screen: where the work happens (project and
// branch), the question, the composer, the quick commands and the recent
// sessions.
func homeScreen(c *ui.Context, a *app.App, st kit.Theme) {
	ui.Column(c).Fill().Children(func() {
		header(c, st, 20, func() { ui.Spacer(c) })
		ui.Scroll(c).Grow(1).Children(func() {
			ui.Column(c).FillWidth().AlignItems(ui.Center).Padding(118, 24, 32, 24).Children(func() {
				ui.Column(c).Width(st.ColumnW).MaxWidthPercent(100).Gap(14).Children(func() {
					ui.Row(c).FillWidth().Justify(ui.Center).Gap(8).Children(func() { whereChips(c, a, st) })
					ui.Row(c).FillWidth().Justify(ui.Center).PaddingY(10).Children(func() {
						ui.Text(c, tr(c, "homeTitle")).FontSize(st.FontDisplay).FontWeight(600).LetterSpacing(-0.8).
							TextColor(st.Text)
					})
					composer(c, a, st, tr(c, "homePlaceholder"))
					quickPrompts(c, a, st)
					recentSessions(c, a, st)
				})
			})
		})
	})
}

// whereChips say which project and branch a new session works in.
func whereChips(c *ui.Context, a *app.App, st kit.Theme) {
	if a.WorkspaceName() == "" {
		st.Btn(c, kit.Button{Label: tr(c, "cmdOpenFolder"), Icon: kit.IconFolderOpen, Small: true}, func() {
			a.Run(app.CmdOpenFolder)
		})
		return
	}
	st.Chip(c, a.WorkspaceName(), func() {
		ui.Icon(c, kit.IconFolder).FontSize(13).TextColor(st.Text2)
		ui.Text(c, a.WorkspaceName()).FontSize(st.FontSmall).FontWeight(500).TextColor(st.Text)
	}, nil)
	if b := a.Branch(); b != "" {
		st.Chip(c, b, func() {
			ui.Icon(c, kit.IconGit).FontSize(13).TextColor(st.Text2)
			ui.Text(c, b).FontSize(st.FontSmall).FontWeight(500).TextColor(st.Text)
			state := tr(c, "branchClean")
			if n := a.ChangesCount(); n > 0 {
				state = trf(c, "branchChanges", map[string]any{"count": n})
			}
			ui.Text(c, "· "+state).FontSize(st.FontSmall).TextColor(st.Text2)
		}, nil)
	}
}

// composer is the prompt card: the text, then a row with mentions, the agent
// and the send (or stop) button. The same card ends the session screen.
func composer(c *ui.Context, a *app.App, st kit.Theme, placeholder string) {
	running := a.AgentState() == agent.StatePrompting || a.AgentState() == agent.StateStarting ||
		a.AgentState() == agent.StateCancelling
	ui.Column(c).FillWidth().Radius(st.RadiusL).Background(st.Surface).Border(1, st.Border2).
		Shadow(0, 1, 2, 0, st.Shadow.Alpha(0.2)).Children(func() {
		in := ui.TextArea(c, a.AgentInput()).FillWidth().Height(44).Placeholder(placeholder).Label(tr(c, "chatInputPlaceholder")).
			Background(st.Surface).Border(0, st.Surface).Padding(12, 14, 4, 14)
		if in.Shortcut(0, ui.KeyEnter) && a.Prefs().SendKey == 0 && !running {
			a.Dispatch(app.SendPrompt{})
		}
		if in.Shortcut(ui.Cmd, ui.KeyEnter) && !running {
			a.Dispatch(app.SendPrompt{})
		}
		ui.Row(c).FillWidth().Padding(6, 8, 8, 8).Gap(6).AlignItems(ui.Center).Children(func() {
			st.IconButton(c, kit.IconAt, tr(c, "composerMention"), false, func() {
				a.Dispatch(app.InsertPrompt{Text: "@"})
			})
			if n := a.AgentChangeCount(); n > 0 && a.Layout.Screen == app.ScreenSession {
				pill(c, st, true, trf(c, "composerChanges", map[string]any{"count": n}), func() {
					ui.Icon(c, kit.IconFileDiff).FontSize(13).TextColor(st.Text2)
					ui.Text(c, trf(c, "composerChanges", map[string]any{"count": n})).FontSize(st.FontRow).TextColor(st.Text2)
				}, func() { a.Dispatch(app.ToggleSidePanel{Name: app.PanelChanges}) })
			}
			ui.Spacer(c)
			agentPill(c, a, st)
			if running {
				e := ui.Box(c).Size(30, 30).Radius(8).Background(st.Text).Justify(ui.Center).AlignItems(ui.Center).
					Focusable().Label(tr(c, "agentCancel")).Tooltip(tr(c, "agentCancel"))
				e.Children(func() { ui.Icon(c, kit.IconStop).FontSize(14).TextColor(st.BG) })
				e.OnClick(func() { a.Dispatch(app.CancelTurn{}) })
				return
			}
			e := ui.Box(c).Size(30, 30).Radius(8).Background(st.Accent).Justify(ui.Center).AlignItems(ui.Center).
				Focusable().Label(tr(c, "chatSend")).Tooltip(tr(c, "chatSend"))
			e.Children(func() { ui.Icon(c, kit.IconArrowUp).FontSize(15).TextColor(st.OnAccent) })
			e.OnClick(func() { a.Dispatch(app.SendPrompt{}) })
		})
	})
}

// pill is a 28 DIP composer control, outlined when bordered.
func pill(c *ui.Context, st kit.Theme, bordered bool, label string, content func(), onClick func()) {
	e := ui.Row(c).Height(28).PaddingX(9).Gap(6).Radius(7).AlignItems(ui.Center).Focusable().Label(label).Shrink(0)
	if bordered {
		e = e.Border(1, st.Border)
	}
	if e.Hovered() {
		e = e.Background(st.Hover)
	}
	e.Children(content)
	if onClick != nil {
		e.OnClick(onClick)
	}
}

// agentPill names the agent the prompt goes to and opens the picker.
func agentPill(c *ui.Context, a *app.App, st kit.Theme) {
	name := a.ActiveAgentName()
	label := name
	if label == "" {
		label = tr(c, "pickerChoose")
	}
	pill(c, st, true, tr(c, "pickerOpen"), func() {
		if name != "" {
			st.AgentMark(c, name, 14)
		}
		ui.Text(c, label).FontSize(st.FontRow).FontWeight(500).TextColor(st.Text).SingleLine()
		ui.Icon(c, kit.IconChevronDown).FontSize(13).TextColor(st.Text3)
	}, func() { a.Dispatch(app.OpenPicker{}) })
}

// quickPrompts are the "/" commands as chips: a click puts the text in the
// composer.
func quickPrompts(c *ui.Context, a *app.App, st kit.Theme) {
	prompts := a.Prefs().Prompts
	if len(prompts) == 0 {
		return
	}
	ui.Row(c).FillWidth().Gap(8).Wrap().Children(func() {
		for i, p := range prompts {
			if i == 3 {
				break
			}
			p := p
			hint := p.Hint
			if hint != "" {
				hint = tr(c, hint)
			}
			e := ui.Row(c).Height(30).PaddingX(11).Gap(8).Radius(7).Background(st.Surface).Border(1, st.Border).
				AlignItems(ui.Center).Focusable().Label(p.Name)
			if e.Hovered() {
				e = e.Background(st.Hover)
			}
			e.Children(func() {
				st.Mono(c, p.Name, st.FontSmall, st.Accent).SingleLine()
				if hint != "" {
					ui.Text(c, hint).FontSize(st.FontSmall).TextColor(st.Text2).SingleLine()
				}
			})
			e.OnClick(func() { a.Dispatch(app.InsertPrompt{Text: p.Text}) })
		}
	})
}

// recentSessions are up to three cards of this project's latest sessions.
func recentSessions(c *ui.Context, a *app.App, st kit.Theme) {
	sessions := a.Sessions()
	if len(sessions) == 0 {
		return
	}
	if len(sessions) > 3 {
		sessions = sessions[:3]
	}
	now := time.Now()
	ui.Column(c).FillWidth().Padding(40, 0, 0, 0).Gap(10).Children(func() {
		ui.Row(c).FillWidth().AlignItems(ui.Center).Children(func() {
			ui.Text(c, tr(c, "homeRecent")).FontSize(st.FontSmall).FontWeight(500).TextColor(st.Text3)
			ui.Spacer(c)
			e := ui.Row(c).Gap(4).Focusable().Label(tr(c, "homeAll"))
			e.Children(func() {
				ui.Text(c, tr(c, "homeAll")).FontSize(st.FontSmall).TextColor(st.Text3)
				st.KeyHint(c, keys("Ctrl", "K"))
			})
			e.OnClick(func() { a.Dispatch(app.OpenSearch{}) })
		})
		ui.Row(c).FillWidth().Gap(10).Children(func() {
			for _, s := range sessions {
				s := s
				title := s.Title
				if title == "" {
					title = trf(c, "sessionUntitled", map[string]any{"agent": s.AgentName})
				}
				e := ui.Column(c).Grow(1).Basis(0).Padding(14, 14, 13, 14).Gap(6).Radius(st.RadiusM).
					Background(st.Surface).Border(1, st.Border).Focusable().Label(title)
				if e.Hovered() {
					e = e.Background(st.Hover)
				}
				e.Children(func() {
					ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
						st.AgentMark(c, s.AgentName, 14)
						ui.Text(c, s.AgentName).FontSize(st.FontSmall).TextColor(st.Text2).SingleLine()
						ui.Spacer(c)
						st.Dot(c, sessionTone(s.State))
					})
					ui.Text(c, title).FontSize(st.FontUI).FontWeight(600).TextColor(st.Text).SingleLine()
					ui.Text(c, sessionMeta(c, s, now)).FontSize(st.FontSmall).TextColor(st.Text3).SingleLine()
				})
				e.OnClick(func() {
					a.Dispatch(app.OpenSearchHit{Hit: app.SearchHit{Kind: "session", AgentID: s.AgentID, Title: s.Title}})
				})
			}
		})
	})
}

func sessionTone(state string) kit.Tone {
	switch state {
	case "running":
		return kit.ToneAccent
	case "waiting":
		return kit.ToneWarn
	case "failed":
		return kit.ToneErr
	}
	return kit.ToneOK
}

func sessionMeta(c *ui.Context, s app.SessionInfo, now time.Time) string {
	var state string
	switch s.State {
	case "running":
		state = tr(c, "stateRunning")
	case "waiting":
		state = tr(c, "stateWaitingShort")
	case "failed":
		state = tr(c, "stateFailed")
	default:
		state = tr(c, "stateDone")
	}
	if t := relTime(c, s.UpdatedAt, now); t != "" {
		return state + " · " + t
	}
	return state
}
