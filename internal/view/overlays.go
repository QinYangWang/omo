package view

import (
	"strings"

	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/kit"
	"github.com/egoist/mygo/ui"
)

// overlays are the floating layers of the window, at most one at a time, the
// most urgent first: a decision the user owes (conflict, trust, the agent
// form), then search, the agent picker and the new-task form.
func overlays(c *ui.Context, a *app.App, st kit.Theme) {
	switch {
	case a.ConflictOpen():
		conflictDialog(c, a, st)
	case a.TrustAgentID() != "":
		trustDialog(c, a, st, a.TrustAgentID())
	case a.AgentConfigForm().Open:
		agentConfigDialog(c, a, st)
	case a.Layout.SearchOpen:
		searchPalette(c, a, st)
	case a.Layout.PickerOpen || a.AgentPickerOpen():
		agentPicker(c, a, st)
	case a.Layout.NewTaskOpen:
		newTaskPopover(c, a, st)
	}
}

// floating draws a panel over a flat scrim: a click on the scrim or Escape
// closes it. The scrim and the panel are siblings, so the panel's own
// controls get their clicks.
func floating(c *ui.Context, st kit.Theme, top, width float32, onClose func(), fn func()) {
	w, h := c.Size()
	if top < 0 {
		top = max(24, h*0.18)
	}
	ui.Overlay(c, func() {
		scrim := ui.Box(c).Absolute().Left(0).Top(0).Size(w, h).Background(st.Scrim).Label("scrim")
		if onClose != nil {
			scrim.OnClick(onClose)
		}
		panel := ui.Column(c).Absolute().Left(max(0, (w-width)/2)).Top(top).Width(width).MaxWidth(w)
		st.Popover(panel).Children(fn)
	})
	if onClose != nil {
		c.OnShortcut(0, ui.KeyEscape, onClose)
	}
}

// searchPalette finds sessions, files and commands; with nothing found it
// offers to hand the words to the agent instead.
func searchPalette(c *ui.Context, a *app.App, st kit.Theme) {
	closeIt := func() { a.Dispatch(app.CloseSearch{}) }
	floating(c, st, 96, 640, closeIt, func() {
		ui.Row(c).FillWidth().Height(52).Padding(0, 16, 0, 16).Gap(10).AlignItems(ui.Center).Children(func() {
			ui.Icon(c, kit.IconSearch).FontSize(17).TextColor(st.Text2)
			in := ui.TextInput(c, &a.Layout.SearchQuery).Grow(1).Placeholder(tr(c, "searchPlaceholder")).
				Label(tr(c, "searchPlaceholder")).Background(st.Raised).Border(0, st.Raised).FontSize(15)
			in.AutoFocus()
			st.Seg(c, &a.Layout.SearchScope, tr(c, "searchAll"), tr(c, "searchSessions"), tr(c, "searchFiles"), tr(c, "searchCommands"))
		})
		st.HRule(c)
		query := strings.TrimSpace(a.Layout.SearchQuery)
		hits := filterHits(a.Search(query, 6), a.Layout.SearchScope)
		ui.Column(c).FillWidth().MaxHeight(380).Children(func() {
			switch {
			case query == "":
				ui.Column(c).FillWidth().Padding(16).Children(func() {
					ui.Text(c, tr(c, "searchHint")).FontSize(st.FontSmall).TextColor(st.Text3)
				})
			case len(hits) == 0:
				searchEmpty(c, a, st, query)
			default:
				ui.Scroll(c).FillWidth().Children(func() { searchResults(c, a, st, hits, query) })
			}
		})
		st.HRule(c)
		ui.Row(c).FillWidth().Height(36).Padding(0, 14, 0, 14).Gap(8).AlignItems(ui.Center).Children(func() {
			st.Keys(c, "↑", "↓")
			ui.Text(c, tr(c, "searchKeySelect")).FontSize(st.FontSmall).TextColor(st.Text3)
			st.Keys(c, "Enter")
			ui.Text(c, tr(c, "searchKeyOpen")).FontSize(st.FontSmall).TextColor(st.Text3)
			ui.Spacer(c)
			st.Keys(c, "esc")
			ui.Text(c, tr(c, "close")).FontSize(st.FontSmall).TextColor(st.Text3)
		})
	})
}

func filterHits(hits []app.SearchHit, scope int) []app.SearchHit {
	if scope == 0 {
		return hits
	}
	kind := []string{"", "session", "file", "command"}[scope]
	out := hits[:0:0]
	for _, h := range hits {
		if h.Kind == kind {
			out = append(out, h)
		}
	}
	return out
}

func searchResults(c *ui.Context, a *app.App, st kit.Theme, hits []app.SearchHit, query string) {
	ui.Column(c).FillWidth().Padding(4, 6, 6, 6).Children(func() {
		last := ""
		for i, h := range hits {
			h := h
			if h.Kind != last {
				last = h.Kind
				ui.Row(c).Height(30).Padding(8, 12, 0, 12).AlignItems(ui.Center).Children(func() {
					ui.Text(c, tr(c, "searchGroup_"+h.Kind)).FontSize(st.FontSmall).TextColor(st.Text3)
				})
			}
			title := h.Title
			if h.Kind == "command" {
				title = tr(c, h.Title)
			}
			e := ui.Row(c).FillWidth().Height(40).PaddingX(12).Gap(10).Radius(8).AlignItems(ui.Center).
				Focusable().Label(title)
			if i == 0 || e.Hovered() {
				e = e.Background(st.Hover)
			}
			e.Children(func() {
				switch h.Kind {
				case "session":
					st.AgentMark(c, h.Meta, 16)
				case "file":
					icon, _ := st.FileIcon(baseName(h.Path))
					ui.Icon(c, icon).FontSize(15).TextColor(st.Text2)
				default:
					ui.Icon(c, kit.IconHash).FontSize(15).TextColor(st.Text2)
				}
				highlight(c, st, title, query, h.Kind == "file")
				if h.Meta != "" && h.Kind != "session" {
					ui.Text(c, h.Meta).FontSize(st.FontSmall).TextColor(st.Text3).SingleLine()
				}
				ui.Spacer(c)
				if i == 0 {
					st.Keys(c, "Enter")
				}
			})
			e.OnClick(func() { a.Dispatch(app.OpenSearchHit{Hit: h}) })
			if i == 0 {
				c.OnShortcut(0, ui.KeyEnter, func() { a.Dispatch(app.OpenSearchHit{Hit: h}) })
			}
		}
	})
}

// highlight draws text with the query's matches in the accent.
func highlight(c *ui.Context, st kit.Theme, text, query string, mono bool) {
	font := ""
	size := st.FontUI
	if mono {
		font, size = kit.FontMono, st.FontSmall
	}
	lower, q := strings.ToLower(text), strings.ToLower(query)
	var spans []ui.Span
	for q != "" {
		i := strings.Index(lower, q)
		if i < 0 {
			break
		}
		if i > 0 {
			spans = append(spans, ui.Span{Text: text[:i], Font: font, Size: size, Color: st.Text})
		}
		spans = append(spans, ui.Span{Text: text[i : i+len(q)], Font: font, Size: size, Color: st.Accent, Weight: 600})
		text, lower = text[i+len(q):], lower[i+len(q):]
	}
	if text != "" {
		spans = append(spans, ui.Span{Text: text, Font: font, Size: size, Color: st.Text})
	}
	ui.RichText(c, spans...).SingleLine().Shrink(1)
}

func searchEmpty(c *ui.Context, a *app.App, st kit.Theme, query string) {
	ui.Column(c).FillWidth().Padding(24, 16, 12, 16).Gap(6).AlignItems(ui.Center).Children(func() {
		ui.Box(c).Size(40, 40).Radius(10).Border(1, st.Border2).Justify(ui.Center).AlignItems(ui.Center).Children(func() {
			ui.Icon(c, kit.IconSearch).FontSize(17).TextColor(st.Text2)
		})
		ui.Text(c, trf(c, "searchNone", map[string]any{"query": query})).FontSize(st.FontUI).FontWeight(600).TextColor(st.Text)
		ui.Text(c, tr(c, "searchNoneHint")).FontSize(st.FontSmall).TextColor(st.Text2)
	})
	name := a.ActiveAgentName()
	if name == "" {
		return
	}
	ui.Column(c).FillWidth().Padding(0, 6, 6, 6).Children(func() {
		ui.Row(c).Height(30).Padding(8, 12, 0, 12).Children(func() {
			ui.Text(c, tr(c, "searchOther")).FontSize(st.FontSmall).TextColor(st.Text3)
		})
		label := trf(c, "searchAsk", map[string]any{"agent": name, "query": query})
		e := ui.Row(c).FillWidth().Height(40).PaddingX(12).Gap(10).Radius(8).Background(st.Hover).AlignItems(ui.Center).
			Focusable().Label(label)
		e.Children(func() {
			st.AgentMark(c, name, 16)
			ui.Text(c, label).FontSize(st.FontUI).TextColor(st.Text).SingleLine().Shrink(1)
			ui.Spacer(c)
			st.Keys(c, "Enter")
		})
		ask := func() {
			a.Dispatch(app.CloseSearch{})
			a.Dispatch(app.InsertPrompt{Text: query})
		}
		e.OnClick(ask)
		c.OnShortcut(0, ui.KeyEnter, ask)
	})
}

// agentPicker chooses the agent a prompt goes to: the configured ACP agents
// with their process state, and the session mode.
func agentPicker(c *ui.Context, a *app.App, st kit.Theme) {
	closeIt := func() {
		a.Dispatch(app.ClosePicker{})
		a.Dispatch(app.CloseAgents{})
	}
	floating(c, st, 258, 560, closeIt, func() {
		ui.Row(c).FillWidth().Height(42).Padding(0, 12, 0, 14).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Icon(c, kit.IconSearch).FontSize(14).TextColor(st.Text3)
			ui.TextInput(c, &a.Layout.PickerQuery).Grow(1).Placeholder(tr(c, "pickerSearch")).Label(tr(c, "pickerSearch")).
				Background(st.Raised).Border(0, st.Raised)
			st.Keys(c, "esc")
		})
		st.HRule(c)
		ui.Row(c).FillWidth().Children(func() {
			ui.Column(c).Width(290).Padding(8).Gap(1).Children(func() {
				ui.Text(c, tr(c, "pickerACP")).FontSize(st.FontMeta).FontWeight(500).TextColor(st.Text3).Padding(4, 8, 6, 8)
				q := strings.ToLower(strings.TrimSpace(a.Layout.PickerQuery))
				for _, p := range a.AgentProcesses() {
					p := p
					if q != "" && !strings.Contains(strings.ToLower(p.Name), q) {
						continue
					}
					active := p.ID == a.ActiveAgentID()
					e := ui.Row(c).FillWidth().Height(44).PaddingX(10).Gap(10).Radius(8).AlignItems(ui.Center).
						Focusable().Label(p.Name)
					if active || e.Hovered() {
						e = e.Background(st.Hover)
					}
					e.Children(func() {
						st.AgentMark(c, p.Name, 20)
						ui.Column(c).Grow(1).Shrink(1).Children(func() {
							ui.Text(c, p.Name).FontSize(st.FontUI).FontWeight(500).TextColor(st.Text).SingleLine()
							_, label := processState(c, p.State)
							ui.Text(c, label).FontSize(st.FontMeta).TextColor(st.Text3).SingleLine()
						})
						tone, _ := processState(c, p.State)
						st.Dot(c, tone)
						if active {
							ui.Icon(c, kit.IconCheck).FontSize(14).TextColor(st.Accent)
						}
					})
					e.OnClick(func() {
						a.Dispatch(app.SelectAgent{ID: p.ID})
						a.Dispatch(app.ClosePicker{})
					})
				}
				st.HRule(c)
				e := ui.Row(c).FillWidth().Height(36).PaddingX(10).Gap(10).Radius(8).AlignItems(ui.Center).Focusable().
					Label(tr(c, "agentAdd"))
				if e.Hovered() {
					e = e.Background(st.Hover)
				}
				e.Children(func() {
					ui.Icon(c, kit.IconPlus).FontSize(14).TextColor(st.Text2)
					ui.Text(c, tr(c, "agentAdd")).FontSize(st.FontUI).TextColor(st.Text2)
				})
				e.OnClick(func() {
					a.Dispatch(app.ClosePicker{})
					a.Dispatch(app.EditAgentConfig{})
				})
			})
			st.VRule(c)
			ui.Column(c).Grow(1).Padding(14, 16).Gap(10).Children(func() {
				ui.Text(c, tr(c, "pickerMode")).FontSize(st.FontMeta).FontWeight(500).TextColor(st.Text3)
				st.Seg(c, &a.Prefs().SessionMode, tr(c, "modeAsk"), tr(c, "modeAuto"), tr(c, "modePlan"))
				hint := []string{"modeAskHint", "modeAutoHint", "modePlanHint"}[min(max(a.Prefs().SessionMode, 0), 2)]
				ui.Text(c, tr(c, hint)).FontSize(st.FontSmall).TextColor(st.Text2)
				ui.Text(c, tr(c, "pickerModels")).FontSize(st.FontSmall).TextColor(st.Text3).Padding(8, 0, 0, 0)
			})
		})
	})
}

// trustDialog asks before omo runs a third-party program for the first time:
// exactly what will run, where, with which variables, and what it may do.
func trustDialog(c *ui.Context, a *app.App, st kit.Theme, id string) {
	d := a.TrustDetails()
	name := a.ActiveAgentName()
	project := a.WorkspaceName()
	cancel := func() { a.Dispatch(app.TrustAgent{ID: ""}) }
	floating(c, st, 150, 480, cancel, func() {
		ui.Column(c).FillWidth().Padding(20).Gap(14).Children(func() {
			ui.Row(c).FillWidth().Gap(12).AlignItems(ui.Center).Children(func() {
				st.AgentMark(c, name, 34)
				ui.Column(c).Grow(1).Children(func() {
					ui.Text(c, trf(c, "trustTitle", map[string]any{"agent": name, "project": project})).FontSize(15).
						FontWeight(600).TextColor(st.Text)
					ui.Text(c, tr(c, "trustLead")).FontSize(st.FontSmall).TextColor(st.Text2)
				})
			})
			ui.Column(c).FillWidth().Radius(8).Background(st.Code).Border(1, st.Border).Padding(10, 12).Gap(4).Children(func() {
				line := func(label, value string) {
					ui.Row(c).Gap(14).Children(func() {
						ui.Box(c).Width(44).Children(func() {
							ui.Text(c, label).FontSize(st.FontMeta).TextColor(st.Text3)
						})
						st.Mono(c, value, 11.5, st.Text).Shrink(1)
					})
				}
				line(tr(c, "trustCommand"), homePath(strings.TrimSpace(d.Executable+" "+strings.Join(d.Args, " "))))
				line(tr(c, "trustDir"), homePath(d.Cwd))
				env := strings.Join(d.Env, ", ")
				if env == "" {
					env = "PATH, HOME"
				}
				line(tr(c, "trustEnv"), env)
			})
			ui.Text(c, tr(c, "trustCan")).FontSize(st.FontSmall).TextColor(st.Text2)
			can := func(icon *ui.SVG, col ui.Color, text, note string) {
				ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
					ui.Icon(c, icon).FontSize(14).TextColor(col)
					ui.Text(c, text).FontSize(st.FontUI).TextColor(st.Text)
					if note != "" {
						ui.Text(c, note).FontSize(st.FontUI).TextColor(st.Text3)
					}
				})
			}
			can(kit.IconCheck, st.OK, tr(c, "trustRead"), "")
			can(kit.IconShieldAlert, st.Warn, tr(c, "trustWrite"), tr(c, "trustWriteNote"))
			ui.Text(c, tr(c, "trustRemember")).FontSize(st.FontSmall).TextColor(st.Text3)
		})
		st.HRule(c)
		ui.Row(c).FillWidth().Padding(12, 20).Gap(8).AlignItems(ui.Center).Background(st.Side).Children(func() {
			st.Btn(c, kit.Button{Label: tr(c, "trustSettings"), Kind: kit.ButtonGhost, Small: true}, func() {
				a.Layout.AgentSel = id
				cancel()
				a.Dispatch(app.OpenSettings{Page: app.SetAgents})
			})
			ui.Spacer(c)
			st.Btn(c, kit.Button{Label: tr(c, "dialogCancel"), Small: true}, cancel)
			st.Btn(c, kit.Button{Label: tr(c, "agentTrustRun"), Kind: kit.ButtonPrimary, Small: true}, func() {
				a.Dispatch(app.TrustAgent{ID: id})
			})
		})
	})
}

// agentConfigDialog adds or edits an ACP agent: a name, the program, its
// arguments and variables, one per line.
func agentConfigDialog(c *ui.Context, a *app.App, st kit.Theme) {
	d := a.AgentConfigForm()
	closeIt := func() { a.Dispatch(app.CloseAgentConfig{}) }
	floating(c, st, -1, 480, closeIt, func() {
		ui.Column(c).FillWidth().Padding(20).Gap(12).Children(func() {
			ui.Text(c, tr(c, "agentConfigTitle")).FontSize(15).FontWeight(600).TextColor(st.Text)
			ui.Text(c, tr(c, "agentConfigHint")).FontSize(st.FontSmall).TextColor(st.Text2)
			field := func(label, hint string, fn func()) {
				ui.Column(c).FillWidth().Gap(5).Children(func() {
					ui.Text(c, label).FontSize(st.FontSmall).FontWeight(500).TextColor(st.Text2)
					fn()
					if hint != "" {
						ui.Text(c, hint).FontSize(st.FontMeta).TextColor(st.Text3)
					}
				})
			}
			field(tr(c, "agentName"), "", func() { ui.TextInput(c, &d.Name).FillWidth().Label(tr(c, "agentName")) })
			field(tr(c, "agentExecutable"), "", func() {
				ui.TextInput(c, &d.Executable).FillWidth().Placeholder("codex-acp").Label(tr(c, "agentExecutable"))
			})
			field(tr(c, "agentArgs"), tr(c, "agentOnePerLine"), func() {
				ui.TextArea(c, &d.Args).FillWidth().Height(56).Placeholder("--acp").Label(tr(c, "agentArgs"))
			})
			field(tr(c, "agentEnv"), tr(c, "agentOnePerLine"), func() {
				ui.TextArea(c, &d.Env).FillWidth().Height(56).Label(tr(c, "agentEnv"))
			})
		})
		st.HRule(c)
		ui.Row(c).FillWidth().Padding(12, 20).Gap(8).Background(st.Side).Children(func() {
			ui.Spacer(c)
			st.Btn(c, kit.Button{Label: tr(c, "dialogCancel"), Small: true}, closeIt)
			st.Btn(c, kit.Button{Label: tr(c, "agentSave"), Kind: kit.ButtonPrimary, Small: true}, func() {
				a.Dispatch(app.SaveAgentConfig{})
			})
		})
	})
}

// conflictDialog asks what to do when a file changed on disk while its buffer
// had unsaved text. It never chooses for the user.
func conflictDialog(c *ui.Context, a *app.App, st kit.Theme) {
	cancel := func() { a.Dispatch(app.ResolveConflict{Choice: app.ConflictCancel}) }
	floating(c, st, -1, 420, cancel, func() {
		ui.Column(c).FillWidth().Padding(20).Gap(10).Children(func() {
			ui.Text(c, tr(c, "conflictTitle")).FontSize(15).FontWeight(600).TextColor(st.Text)
			ui.Text(c, trf(c, "conflictMessage", map[string]any{"path": a.ConflictPath()})).FontSize(st.FontUI).TextColor(st.Text2)
		})
		st.HRule(c)
		ui.Row(c).FillWidth().Padding(12, 20).Gap(8).Background(st.Side).Children(func() {
			ui.Spacer(c)
			st.Btn(c, kit.Button{Label: tr(c, "conflictCancel"), Kind: kit.ButtonGhost, Small: true}, cancel)
			st.Btn(c, kit.Button{Label: tr(c, "conflictOverwrite"), Small: true}, func() {
				a.Dispatch(app.ResolveConflict{Choice: app.ConflictOverwrite})
			})
			st.Btn(c, kit.Button{Label: tr(c, "conflictReload"), Kind: kit.ButtonPrimary, Small: true}, func() {
				a.Dispatch(app.ResolveConflict{Choice: app.ConflictReload})
			})
		})
	})
}
