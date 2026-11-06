package view

import (
	"strings"
	"time"

	"github.com/QinYangWang/omo/internal/agent"
	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/kit"
	"github.com/egoist/mygo/ui"
)

// sessionScreen is a session: its title bar, the conversation column with the
// composer, and at the right either the 300 DIP inspector or the 520 DIP side
// panel.
func sessionScreen(c *ui.Context, a *app.App, st kit.Theme) {
	ui.Column(c).Fill().Children(func() {
		sessionHeader(c, a, st)
		st.HRule(c)
		ui.Row(c).Grow(1).FillWidth().Children(func() {
			width := st.ColumnW
			switch {
			case a.Layout.SidePanel != "":
				width = 440
			case a.Layout.Inspector:
				width = 640
			}
			ui.Column(c).Grow(1).FillHeight().Children(func() {
				ui.Scroll(c).Grow(1).Children(func() {
					ui.Column(c).FillWidth().AlignItems(ui.Center).Padding(22, 24, 16, 24).Children(func() {
						ui.Column(c).Width(width).MaxWidthPercent(100).Children(func() { transcript(c, a, st) })
					})
				})
				ui.Column(c).FillWidth().AlignItems(ui.Center).Padding(10, 24, 0, 24).Children(func() {
					ui.Column(c).Width(width).MaxWidthPercent(100).Children(func() {
						placeholder := tr(c, "sessionPlaceholderNoAgent")
						switch {
						case a.AgentState() == agent.StateError:
							placeholder = tr(c, "sessionPlaceholderOffline")
						case a.Permission() != nil:
							placeholder = tr(c, "sessionPlaceholderWaiting")
						case a.ActiveAgentName() != "":
							placeholder = trf(c, "sessionPlaceholder", map[string]any{"agent": a.ActiveAgentName()})
						}
						composer(c, a, st, placeholder)
						statusLine(c, a, st)
					})
				})
			})
			switch {
			case a.Layout.SidePanel != "":
				st.VRule(c)
				sidePanel(c, a, st)
			case a.Layout.Inspector:
				st.VRule(c)
				inspector(c, a, st)
			}
		})
	})
}

func sessionHeader(c *ui.Context, a *app.App, st kit.Theme) {
	header(c, st, 20, func() {
		title := a.SessionTitle()
		if title == "" {
			title = tr(c, "sessionNew")
		}
		ui.Text(c, title).FontSize(st.FontTitle).FontWeight(600).TextColor(st.Text).SingleLine().Shrink(1)
		if name := a.ActiveAgentName(); name != "" {
			st.Chip(c, name, func() {
				st.AgentMark(c, name, 14)
				ui.Text(c, name).FontSize(st.FontSmall).FontWeight(500).TextColor(st.Text).SingleLine()
			}, func() { a.Dispatch(app.OpenPicker{}) })
		}
		stateTag(c, a, st)
		ui.Spacer(c)
		st.TitleButton(c, kit.IconPlan, tr(c, "inspectorPlan"), a.Layout.Inspector && a.Layout.SidePanel == "", nil,
			func() { a.Dispatch(app.ToggleInspector{}) })
		added, deleted := a.ChangeTotals()
		var counts func()
		if added+deleted > 0 {
			counts = func() {
				ui.Text(c, plus(added)).Font(kit.FontMono).FontSize(st.FontSmall).TextColor(st.OK)
				ui.Text(c, minus(deleted)).Font(kit.FontMono).FontSize(st.FontSmall).TextColor(st.Err)
			}
		}
		st.TitleButton(c, kit.IconFileDiff, tr(c, "panelChanges"), a.Layout.SidePanel == app.PanelChanges, counts,
			func() { a.Dispatch(app.ToggleSidePanel{Name: app.PanelChanges}) })
		st.IconButton(c, kit.IconTerminalSquare, tr(c, "panelTerminal"), a.Layout.SidePanel == app.PanelTerminal,
			func() { a.Dispatch(app.ToggleSidePanel{Name: app.PanelTerminal}) })
		st.IconButton(c, kit.IconFiles, tr(c, "panelFiles"), a.Layout.SidePanel == app.PanelFiles,
			func() { a.Dispatch(app.ToggleSidePanel{Name: app.PanelFiles}) })
	})
}

// stateTag is the session's state beside its title.
func stateTag(c *ui.Context, a *app.App, st kit.Theme) {
	switch {
	case a.Permission() != nil:
		st.Tag(c, kit.IconShieldAlert, tr(c, "stateWaiting"), kit.ToneWarn)
	case a.AgentState() == agent.StateError:
		st.Tag(c, kit.IconCircleX, tr(c, "stateOffline"), kit.ToneErr)
	case a.AgentState() == agent.StatePrompting || a.AgentState() == agent.StateStarting:
		st.Tag(c, kit.IconLoader, tr(c, "stateRunning"), kit.ToneAccent)
	case a.AgentState() == agent.StateCancelling:
		st.Tag(c, kit.IconLoader, tr(c, "agentCancelling"), kit.ToneNeutral)
	case a.LastTurn().Done:
		st.Tag(c, kit.IconCheck, tr(c, "stateDone"), kit.ToneOK)
	}
}

// statusLine is the 34 DIP line under the composer: the project's directory
// and branch.
func statusLine(c *ui.Context, a *app.App, st kit.Theme) {
	ui.Row(c).Height(st.BarH).FillWidth().Gap(14).AlignItems(ui.Center).Children(func() {
		if p := a.WorkspacePath(); p != "" {
			ui.Row(c).Gap(5).AlignItems(ui.Center).Children(func() {
				ui.Icon(c, kit.IconFolder).FontSize(12).TextColor(st.Text3)
				st.Mono(c, homePath(p), 11.5, st.Text3).SingleLine()
			})
		}
		if b := a.Branch(); b != "" {
			ui.Row(c).Gap(5).AlignItems(ui.Center).Children(func() {
				ui.Icon(c, kit.IconGit).FontSize(12).TextColor(st.Text3)
				st.Mono(c, b, 11.5, st.Text3).SingleLine()
			})
		}
		ui.Spacer(c)
		if total, _ := a.ToolCalls(); total > 0 {
			st.Mono(c, trf(c, "statusTools", map[string]any{"count": total}), 11.5, st.Text3).SingleLine()
		}
	})
}

// transcript draws the conversation: the user's messages as bubbles at the
// right, the agent's text, its tool calls as cards (consecutive reads folded
// into one line), the pending approval, and the error card when the agent
// could not start.
func transcript(c *ui.Context, a *app.App, st kit.Theme) {
	items := a.ChatItems()
	if len(items) == 0 && a.AgentState() != agent.StateError {
		st.EmptyState(c, kit.IconChat, tr(c, "sessionEmptyTitle"), tr(c, "chatHint"))
	}
	for i := 0; i < len(items); {
		it := items[i]
		switch {
		case it.User:
			userBubble(c, st, it.Text)
			i++
		case it.Kind == agent.EventTool:
			j := i
			for j < len(items) && items[j].Kind == agent.EventTool && !items[j].User {
				j++
			}
			toolGroup(c, a, st, items[i:j])
			i = j
		case it.Kind == agent.EventThought:
			ui.Text(c, it.Text).FontSize(st.FontSmall).TextColor(st.Text3).Padding(0, 0, 10, 0)
			i++
		default:
			agentText(c, st, it.Text)
			i++
		}
	}
	if p := a.Permission(); p != nil {
		permissionCard(c, a, st, p)
	}
	if a.AgentState() == agent.StateError {
		errorCard(c, a, st)
	}
	turnLine(c, a, st)
}

func userBubble(c *ui.Context, st kit.Theme, text string) {
	ui.Row(c).FillWidth().Justify(ui.End).Padding(0, 0, 18, 0).Children(func() {
		ui.Column(c).MaxWidth(520).Padding(9, 13).Radius(st.RadiusM).Background(st.Surface).Border(1, st.Border).
			Children(func() {
				ui.Text(c, text).FontSize(st.FontUI).TextColor(st.Text).LineHeight(1.55)
			})
	})
}

// agentText draws the agent's text a paragraph at a time; `code` spans are set
// in mono on a tint, as the design writes paths and names.
func agentText(c *ui.Context, st kit.Theme, text string) {
	ui.Column(c).FillWidth().Gap(10).Padding(0, 0, 10, 0).Children(func() {
		for _, para := range strings.Split(strings.TrimSpace(text), "\n") {
			if strings.TrimSpace(para) == "" {
				continue
			}
			paragraph(c, st, para)
		}
	})
}

func paragraph(c *ui.Context, st kit.Theme, para string) {
	parts := strings.Split(para, "`")
	if len(parts) < 3 {
		ui.Text(c, para).FontSize(st.FontUI).TextColor(st.Text).LineHeight(1.55)
		return
	}
	spans := make([]ui.Span, 0, len(parts))
	for i, p := range parts {
		if p == "" {
			continue
		}
		if i%2 == 1 {
			spans = append(spans, ui.Span{Text: p, Font: kit.FontMono, Size: st.FontSmall, Color: st.Text, Background: st.Hover, Radius: 4})
		} else {
			spans = append(spans, ui.Span{Text: p, Size: st.FontUI, Color: st.Text})
		}
	}
	ui.RichText(c, spans...).LineHeight(1.55)
}

// toolGroup draws a run of tool calls: reads and searches folded into one line
// when the setting asks for it, every other call a row of one card.
func toolGroup(c *ui.Context, a *app.App, st kit.Theme, items []app.ChatItem) {
	var reads, rest []app.ChatItem
	for _, it := range items {
		if a.Prefs().CollapseReads && (it.ToolKind == "read" || it.ToolKind == "search") && !it.Allowed {
			reads = append(reads, it)
		} else {
			rest = append(rest, it)
		}
	}
	if len(reads) > 1 {
		foldedReads(c, st, reads)
	} else {
		rest = items
	}
	if len(rest) == 0 {
		return
	}
	ui.Column(c).FillWidth().Radius(8).Background(st.Surface).Border(1, st.Border).Clip().Margin(0, 0, 8, 0).Children(func() {
		for i, it := range rest {
			if i > 0 {
				st.HRule(c)
			}
			toolRow(c, st, it)
		}
	})
}

func foldedReads(c *ui.Context, st kit.Theme, reads []app.ChatItem) {
	files, searches := 0, 0
	done := true
	for _, it := range reads {
		if it.ToolKind == "search" {
			searches++
		} else {
			files += max(1, len(it.Paths))
		}
		if it.ToolStatus != "completed" {
			done = false
		}
	}
	label := trf(c, "toolsFolded", map[string]any{"files": files, "searches": searches})
	ui.Row(c).FillWidth().Height(36).PaddingX(12).Gap(10).Radius(8).Background(st.Surface).Border(1, st.Border).
		AlignItems(ui.Center).Margin(0, 0, 8, 0).Label(label).Children(func() {
		ui.Icon(c, kit.IconChevronRight).FontSize(13).TextColor(st.Text3)
		ui.Text(c, label).FontSize(st.FontRow).TextColor(st.Text2).SingleLine()
		ui.Spacer(c)
		if done {
			ui.Icon(c, kit.IconCheck).FontSize(13).TextColor(st.OK)
		} else {
			ui.Icon(c, kit.IconLoader).FontSize(13).TextColor(st.Accent)
		}
	})
}

// toolVerb is the icon and the word of a tool call's kind.
func toolVerb(c *ui.Context, kind string) (*ui.SVG, string) {
	switch kind {
	case "read":
		return kit.IconFileText, tr(c, "toolRead")
	case "edit":
		return kit.IconPencil, tr(c, "toolEdit")
	case "delete":
		return kit.IconTrash, tr(c, "toolDelete")
	case "move":
		return kit.IconArrowRight, tr(c, "toolMove")
	case "search":
		return kit.IconSearch, tr(c, "toolSearch")
	case "execute":
		return kit.IconTerminalSquare, tr(c, "toolRun")
	case "fetch":
		return kit.IconGlobe, tr(c, "toolFetch")
	case "think":
		return kit.IconSparkle, tr(c, "toolThink")
	}
	return kit.IconBot, tr(c, "toolOther")
}

func toolRow(c *ui.Context, st kit.Theme, it app.ChatItem) {
	icon, verb := toolVerb(c, it.ToolKind)
	target := strings.Join(it.Command, " ")
	if target == "" && len(it.Paths) > 0 {
		target = it.Paths[0]
		if len(it.Paths) > 1 {
			target += trf(c, "toolMorePaths", map[string]any{"count": len(it.Paths) - 1})
		}
	}
	if target == "" {
		target = it.ToolTitle
	}
	ui.Row(c).FillWidth().Height(36).PaddingX(12).Gap(10).AlignItems(ui.Center).Children(func() {
		if it.Allowed {
			ui.Icon(c, kit.IconShieldCheck).FontSize(14).TextColor(st.OK)
			ui.Text(c, tr(c, "toolAllowed")+" · "+verb).FontSize(st.FontRow).TextColor(st.Text2).SingleLine()
		} else {
			ui.Icon(c, icon).FontSize(14).TextColor(st.Text2)
			ui.Text(c, verb).FontSize(st.FontRow).TextColor(st.Text2).SingleLine()
		}
		st.Mono(c, target, st.FontSmall, st.Text).SingleLine().Shrink(1)
		ui.Spacer(c)
		switch it.ToolStatus {
		case "completed":
			ui.Icon(c, kit.IconCheck).FontSize(13).TextColor(st.OK)
		case "failed":
			ui.Icon(c, kit.IconX).FontSize(13).TextColor(st.Err)
		default:
			ui.Icon(c, kit.IconLoader).FontSize(13).TextColor(st.Accent)
		}
	})
}

// permissionCard is an approval asked inline, in amber: what the agent wants
// to do, on which paths or with which command, and the three answers.
func permissionCard(c *ui.Context, a *app.App, st kit.Theme, p *app.AgentPermission) {
	name := a.ActiveAgentName()
	_, verb := toolVerb(c, p.Kind)
	ui.Column(c).FillWidth().Radius(st.RadiusM).Background(st.Surface).Border(1, st.WarnLine).Clip().
		Margin(4, 0, 8, 0).Children(func() {
		ui.Row(c).FillWidth().Padding(11, 14).Gap(10).AlignItems(ui.Center).Background(st.WarnBg).
			BorderWidth(0, 0, 1, 0).BorderColor(st.WarnLine).Children(func() {
			ui.Icon(c, kit.IconShieldAlert).FontSize(15).TextColor(st.Warn)
			ui.Text(c, trf(c, "permAsks", map[string]any{"agent": name, "action": verb})).FontSize(st.FontUI).
				FontWeight(600).TextColor(st.Text).SingleLine()
			if p.Title != "" {
				ui.Text(c, "· "+p.Title).FontSize(st.FontUI).TextColor(st.Text2).SingleLine().Shrink(1)
			}
			ui.Spacer(c)
			if p.Kind != "" {
				st.Mono(c, p.Kind, st.FontMeta, st.Text3)
			}
		})
		ui.Column(c).FillWidth().Padding(12, 14).Gap(8).Children(func() {
			for _, path := range p.Paths {
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					icon, _ := st.FileIcon(baseName(path))
					ui.Icon(c, icon).FontSize(14).TextColor(st.OK)
					st.Mono(c, path, st.FontSmall, st.Text).SingleLine()
				})
			}
			if len(p.Command) > 0 {
				st.CodeWell(c, []string{"$ " + strings.Join(p.Command, " ")}, nil)
			} else if p.Input != "" {
				st.CodeWell(c, []string{p.Input}, nil)
			}
		})
		ui.Row(c).FillWidth().Padding(0, 14, 12, 14).Gap(8).AlignItems(ui.Center).Children(func() {
			for _, o := range p.Options {
				o := o
				switch o.Kind {
				case "allow_once":
					st.Btn(c, kit.Button{Label: tr(c, "permAllowOnce"), Kind: kit.ButtonPrimary, Small: true, Key: "Enter"},
						func() { a.Dispatch(app.ResolvePermission{OptionID: o.ID}) })
					st.Btn(c, kit.Button{Label: tr(c, "permAllowSession"), Small: true},
						func() { a.Dispatch(app.AllowForSession{}) })
				case "reject_once":
					st.Btn(c, kit.Button{Label: tr(c, "permReject"), Kind: kit.ButtonGhost, Small: true},
						func() { a.Dispatch(app.ResolvePermission{OptionID: o.ID}) })
				}
			}
			ui.Spacer(c)
			ui.Text(c, tr(c, "permWaiting")).FontSize(st.FontSmall).TextColor(st.Text3).SingleLine()
		})
	})
}

// errorCard says why the agent is not there, shows what its process printed and
// offers three ways on: sign in again, retry, or hand the message to another
// agent.
func errorCard(c *ui.Context, a *app.App, st kit.Theme) {
	name := a.ActiveAgentName()
	cause := tr(c, "errorCause")
	if d := a.AgentDiagnostics(); len(d) > 0 {
		cause = d[len(d)-1]
		if i := strings.Index(cause, " | raw="); i >= 0 {
			cause = cause[:i]
		}
	}
	output := a.AgentOutput(6)
	var other agent.Definition
	for _, d := range a.AgentDefinitions() {
		// An untrusted agent asks for trust before it takes the message.
		if d.ID != a.ActiveAgentID() {
			other = d
			break
		}
	}
	ui.Column(c).FillWidth().Radius(st.RadiusM).Background(st.Surface).Border(1, st.ErrLine).Clip().Margin(4, 0, 8, 0).
		Children(func() {
			ui.Row(c).FillWidth().Padding(14, 16).Gap(12).Background(st.ErrBg).BorderWidth(0, 0, 1, 0).
				BorderColor(st.ErrLine).Children(func() {
				ui.Icon(c, kit.IconCircleX).FontSize(17).TextColor(st.Err)
				ui.Column(c).Grow(1).Shrink(1).Gap(2).Children(func() {
					ui.Text(c, trf(c, "errorTitle", map[string]any{"agent": name})).FontSize(st.FontUI).FontWeight(600).
						TextColor(st.Text)
					ui.Text(c, cause).FontSize(st.FontUI).TextColor(st.Text2)
				})
			})
			ui.Column(c).FillWidth().Padding(16).Gap(10).Children(func() {
				if len(output) > 0 {
					ui.Row(c).FillWidth().AlignItems(ui.Center).Children(func() {
						ui.Text(c, trf(c, "errorOutput", map[string]any{"count": len(output)})).FontSize(st.FontSmall).
							TextColor(st.Text2)
						ui.Spacer(c)
						st.Btn(c, kit.Button{Label: tr(c, "copy"), Icon: kit.IconCopy, Kind: kit.ButtonGhost, Small: true},
							func() { c.WriteClipboard(strings.Join(output, "\n")) })
					})
					st.CodeWell(c, output, func(l string) bool {
						lower := strings.ToLower(l)
						return strings.Contains(lower, "error") || strings.Contains(lower, "fatal")
					})
				}
				ui.Text(c, tr(c, "errorFixes")).FontSize(st.FontSmall).TextColor(st.Text2).Padding(4, 0, 0, 0)
				st.Card(c, func() {
					fixRow(c, st, kit.IconKey, trf(c, "errorRelogin", map[string]any{"agent": name}), tr(c, "errorReloginHint"),
						kit.Button{Label: tr(c, "errorOpenTerminal"), Icon: kit.IconTerminalSquare, Small: true},
						func() { a.Dispatch(app.ReLogin{}) })
					st.HRule(c)
					fixRow(c, st, kit.IconRefresh, tr(c, "errorRetry"), tr(c, "errorRetryHint"),
						kit.Button{Label: tr(c, "retry"), Small: true},
						func() { a.Dispatch(app.StartAgent{ID: a.ActiveAgentID()}) })
					if other.ID != "" {
						st.HRule(c)
						id := other.ID
						fixRow(c, st, kit.IconArrowRight, tr(c, "errorSwitch"),
							trf(c, "errorSwitchHint", map[string]any{"agent": other.Name}),
							kit.Button{Label: trf(c, "errorContinueWith", map[string]any{"agent": other.Name}), Kind: kit.ButtonPrimary, Small: true},
							func() { a.Dispatch(app.ContinueWith{ID: id}) })
					}
				})
			})
		})
	ui.Row(c).Gap(6).AlignItems(ui.Center).Padding(0, 0, 10, 0).Children(func() {
		ui.Icon(c, kit.IconHistory).FontSize(13).TextColor(st.Text3)
		e := ui.Text(c, tr(c, "errorSettings")).FontSize(st.FontSmall).TextColor(st.Text2).Underline().Focusable().
			Label(tr(c, "errorSettings"))
		e.OnClick(func() {
			a.Layout.AgentSel = a.ActiveAgentID()
			a.Dispatch(app.OpenSettings{Page: app.SetAgents})
		})
	})
}

func fixRow(c *ui.Context, st kit.Theme, icon *ui.SVG, title, hint string, b kit.Button, onClick func()) {
	ui.Row(c).FillWidth().Padding(12, 16).Gap(14).AlignItems(ui.Center).Children(func() {
		ui.Box(c).Size(28, 28).Radius(7).Background(st.Hover).Justify(ui.Center).AlignItems(ui.Center).Children(func() {
			ui.Icon(c, icon).FontSize(14).TextColor(st.Text2)
		})
		ui.Column(c).Grow(1).Shrink(1).Children(func() {
			ui.Text(c, title).FontSize(st.FontUI).TextColor(st.Text)
			ui.Text(c, hint).FontSize(st.FontSmall).TextColor(st.Text3)
		})
		st.Btn(c, b, onClick)
	})
}

// turnLine is the quiet line after the agent's answer: done in how long with
// how many tool calls, or how long it has been working.
func turnLine(c *ui.Context, a *app.App, st kit.Theme) {
	started := a.TurnStarted()
	switch {
	case !started.IsZero() && (a.AgentState() == agent.StatePrompting || a.AgentState() == agent.StateStarting ||
		a.AgentState() == agent.StateCancelling):
		key := "turnWorking"
		if a.Permission() != nil {
			key = "turnWaiting"
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).PaddingY(6).Children(func() {
			ui.Icon(c, kit.IconLoader).FontSize(13).TextColor(st.Accent)
			ui.Text(c, trf(c, key, map[string]any{"time": duration(c, time.Since(started))})).FontSize(st.FontSmall).
				TextColor(st.Text2)
		})
	case a.LastTurn().Done && a.AgentState() != agent.StateError:
		t := a.LastTurn()
		ui.Row(c).Gap(6).AlignItems(ui.Center).PaddingY(2).Children(func() {
			ui.Icon(c, kit.IconCheckCheck).FontSize(13).TextColor(st.Text3)
			ui.Text(c, trf(c, "turnDone", map[string]any{"time": duration(c, t.Duration), "count": t.ToolCalls})).
				FontSize(11.5).TextColor(st.Text3)
		})
	}
}
