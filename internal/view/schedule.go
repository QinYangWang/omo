package view

import (
	"strings"

	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/kit"
	"github.com/egoist/mygo/ui"
)

// scheduleScreen lists the scheduled tasks with their schedule and state, and
// the chosen task's prompt and settings at the right.
func scheduleScreen(c *ui.Context, a *app.App, st kit.Theme) {
	tasks := a.Prefs().Tasks
	ui.Column(c).Fill().Children(func() {
		header(c, st, 20, func() {
			ui.Text(c, tr(c, "navSchedule")).FontSize(st.FontTitle).FontWeight(600).TextColor(st.Text)
			ui.Text(c, tr(c, "schedLead")).FontSize(st.FontSmall).TextColor(st.Text3).SingleLine()
			ui.Spacer(c)
			st.Btn(c, kit.Button{Label: tr(c, "schedNew"), Icon: kit.IconPlus, Kind: kit.ButtonPrimary, Small: true},
				func() { a.Dispatch(app.NewTask{}) })
		})
		st.HRule(c)
		ui.Row(c).Grow(1).FillWidth().Children(func() {
			ui.Scroll(c).Grow(1).FillHeight().Children(func() {
				ui.Column(c).FillWidth().Padding(20, 22).Gap(14).Children(func() {
					enabled := 0
					for _, t := range tasks {
						if t.Enabled {
							enabled++
						}
					}
					st.Seg(c, &a.Layout.TaskFilter,
						trf(c, "schedAll", map[string]any{"count": len(tasks)}),
						trf(c, "schedEnabled", map[string]any{"count": enabled}),
						trf(c, "schedPaused", map[string]any{"count": len(tasks) - enabled}))
					if len(tasks) == 0 {
						st.Card(c, func() {
							st.EmptyState(c, kit.IconSchedule, tr(c, "schedEmpty"), tr(c, "schedEmptyHint"))
						})
					} else {
						taskTable(c, a, st, tasks)
					}
					ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
						ui.Icon(c, kit.IconInfo).FontSize(13).TextColor(st.Text3)
						ui.Text(c, tr(c, "schedNote")).FontSize(st.FontSmall).TextColor(st.Text3)
					})
				})
			})
			if i := a.Layout.TaskSel; i >= 0 && i < len(tasks) {
				st.VRule(c)
				taskDetail(c, a, st, i, tasks[i])
			}
		})
	})
}

func taskTable(c *ui.Context, a *app.App, st kit.Theme, tasks []app.ScheduledTask) {
	st.Card(c, func() {
		ui.Row(c).FillWidth().Height(34).Padding(0, 14, 0, 44).Gap(12).AlignItems(ui.Center).Children(func() {
			col := func(w float32, key string) {
				e := ui.Box(c)
				if w > 0 {
					e = e.Width(w)
				} else {
					e = e.Grow(1)
				}
				e.Children(func() { ui.Text(c, tr(c, key)).FontSize(st.FontSmall).TextColor(st.Text3) })
			}
			col(0, "schedColTask")
			col(150, "schedColNext")
			col(150, "schedColLast")
			col(40, "schedColOn")
		})
		for i, t := range tasks {
			i, t := i, t
			switch a.Layout.TaskFilter {
			case 1:
				if !t.Enabled {
					continue
				}
			case 2:
				if t.Enabled {
					continue
				}
			}
			st.HRule(c)
			row := ui.Row(c).FillWidth().Height(56).Padding(0, 14, 0, 0).Gap(12).AlignItems(ui.Center)
			if i == a.Layout.TaskSel {
				row = row.Background(st.Hover)
			}
			fg, fg2 := st.Text, st.Text3
			if !t.Enabled {
				fg, fg2 = st.Text3, st.Text3
			}
			row.Children(func() {
				// The row's body and its switch are siblings: a click target
				// nested in another does not get the click.
				e := ui.Row(c).Grow(1).FillHeight().Padding(0, 0, 0, 14).Gap(12).AlignItems(ui.Center).
					Focusable().Label(t.Name)
				e.Children(func() {
					st.AgentMark(c, agentNameOf(a, t.AgentID), 18)
					ui.Column(c).Grow(1).Shrink(1).Children(func() {
						ui.Text(c, t.Name).FontSize(st.FontUI).FontWeight(600).TextColor(fg).SingleLine()
						ui.Text(c, t.Project+" · "+scheduleText(c, t.Schedule)).FontSize(st.FontSmall).TextColor(fg2).SingleLine()
					})
					ui.Column(c).Width(150).Children(func() {
						ui.Text(c, tr(c, "schedNext")).FontSize(st.FontMeta).TextColor(st.Text3)
						next := scheduleText(c, t.Schedule)
						if !t.Enabled {
							next = tr(c, "schedPausedOne")
						}
						ui.Text(c, next).FontSize(st.FontUI).TextColor(fg).SingleLine()
					})
					ui.Row(c).Width(150).Gap(8).AlignItems(ui.Center).Children(func() {
						st.Dot(c, kit.ToneOff)
						ui.Text(c, tr(c, "schedNeverRan")).FontSize(st.FontUI).TextColor(fg2).SingleLine()
					})
				})
				e.OnClick(func() { a.Layout.TaskSel = i })
				ui.Box(c).Width(40).Children(func() {
					st.Toggle(c, t.Enabled, trf(c, "schedToggle", map[string]any{"name": t.Name}), func() {
						a.Dispatch(app.ToggleTask{Index: i})
					})
				})
			})
		}
	})
}

// scheduleText turns a stored "schedWeekdays 09:00" into words.
func scheduleText(c *ui.Context, s string) string {
	key, when, _ := strings.Cut(s, " ")
	return trf(c, key, map[string]any{"time": when})
}

func agentNameOf(a *app.App, id string) string {
	for _, d := range a.AgentDefinitions() {
		if d.ID == id {
			return d.Name
		}
	}
	return id
}

func taskDetail(c *ui.Context, a *app.App, st kit.Theme, i int, t app.ScheduledTask) {
	ui.Scroll(c).Width(340).FillHeight().Children(func() {
		ui.Column(c).FillWidth().Padding(18).Gap(18).Children(func() {
			ui.Row(c).FillWidth().Gap(12).AlignItems(ui.Center).Children(func() {
				name := agentNameOf(a, t.AgentID)
				st.AgentMark(c, name, 22)
				ui.Column(c).Grow(1).Shrink(1).Children(func() {
					ui.Text(c, t.Name).FontSize(15).FontWeight(600).TextColor(st.Text).SingleLine()
					ui.Text(c, name+" · "+t.Project).FontSize(st.FontSmall).TextColor(st.Text3).SingleLine()
				})
				st.IconButton(c, kit.IconTrash, tr(c, "schedDelete"), false, func() { a.Dispatch(app.DeleteTask{Index: i}) })
			})
			ui.Column(c).FillWidth().Gap(8).Children(func() {
				ui.Text(c, tr(c, "schedPrompt")).FontSize(st.FontSmall).FontWeight(500).TextColor(st.Text3)
				ui.Column(c).FillWidth().Padding(12, 14).Radius(st.RadiusM).Background(st.Surface).Border(1, st.Border).Children(func() {
					ui.Text(c, t.Prompt).FontSize(st.FontUI).TextColor(st.Text).LineHeight(1.6)
				})
			})
			ui.Column(c).FillWidth().Gap(4).Children(func() {
				ui.Text(c, tr(c, "schedPlan")).FontSize(st.FontSmall).FontWeight(500).TextColor(st.Text3).Padding(0, 0, 4, 0)
				factRow(c, st, tr(c, "schedTime"), func() {
					ui.Text(c, scheduleText(c, t.Schedule)).FontSize(st.FontRow).TextColor(st.Text)
				})
				if t.Branch != "" {
					factRow(c, st, tr(c, "schedBranch"), func() { st.Mono(c, t.Branch, st.FontSmall, st.Text) })
				}
				factRow(c, st, tr(c, "factMode"), func() {
					st.Tag(c, nil, tr(c, []string{"modeAsk", "modeAuto", "modePlan"}[min(max(t.Mode, 0), 2)]), kit.ToneAccent)
				})
			})
			ui.Column(c).FillWidth().Gap(8).Children(func() {
				ui.Text(c, tr(c, "schedRuns")).FontSize(st.FontSmall).FontWeight(500).TextColor(st.Text3)
				st.HRule(c)
				ui.Text(c, tr(c, "schedNoRuns")).FontSize(st.FontSmall).TextColor(st.Text3)
			})
		})
	})
}

// newTaskPopover is the form of a new scheduled task.
func newTaskPopover(c *ui.Context, a *app.App, st kit.Theme) {
	d := a.TaskDraft()
	closeIt := func() { a.Layout.NewTaskOpen = false }
	floating(c, st, 90, 560, closeIt, func() {
		ui.Row(c).FillWidth().Height(52).Padding(0, 12, 0, 20).AlignItems(ui.Center).Children(func() {
			ui.Text(c, tr(c, "schedNewTitle")).FontSize(15).FontWeight(600).TextColor(st.Text)
			ui.Spacer(c)
			st.IconButton(c, kit.IconX, tr(c, "close"), false, closeIt)
		})
		st.HRule(c)
		ui.Column(c).FillWidth().Padding(18, 20).Gap(14).Children(func() {
			field := func(label string, fn func()) {
				ui.Column(c).FillWidth().Gap(6).Children(func() {
					ui.Text(c, label).FontSize(st.FontSmall).FontWeight(500).TextColor(st.Text2)
					fn()
				})
			}
			field(tr(c, "schedName"), func() {
				ui.TextInput(c, &d.Name).FillWidth().Placeholder(tr(c, "schedNameHint")).Label(tr(c, "schedName")).AutoFocus()
			})
			field(tr(c, "schedPrompt"), func() {
				ui.TextArea(c, &d.Prompt).FillWidth().Height(84).Placeholder(tr(c, "schedPromptHint")).Label(tr(c, "schedPrompt"))
			})
			ui.Row(c).FillWidth().Gap(14).Children(func() {
				ui.Column(c).Grow(1).Children(func() {
					field(tr(c, "schedRepeat"), func() {
						labels := make([]string, len(app.TaskSchedules))
						for i, k := range app.TaskSchedules {
							labels[i] = tr(c, k+"Short")
						}
						st.Seg(c, &d.Schedule, labels...)
					})
				})
				ui.Column(c).Width(110).Children(func() {
					field(tr(c, "schedTime"), func() {
						ui.TextInput(c, &d.Time).FillWidth().Placeholder("09:00").Label(tr(c, "schedTime"))
					})
				})
			})
			ui.Row(c).FillWidth().Gap(14).Children(func() {
				ui.Column(c).Grow(1).Basis(0).Children(func() {
					field("Agent", func() {
						defs := a.AgentDefinitions()
						names := make([]string, len(defs))
						sel := 0
						for i, def := range defs {
							names[i] = def.Name
							if def.ID == d.AgentID {
								sel = i
							}
						}
						if len(names) == 0 {
							ui.Text(c, tr(c, "agentUnconfigured")).FontSize(st.FontSmall).TextColor(st.Text3)
							return
						}
						st.SelectBox(c, "Agent", &sel, names)
						d.AgentID = defs[sel].ID
					})
				})
				ui.Column(c).Grow(1).Basis(0).Children(func() {
					field(tr(c, "schedBranch"), func() {
						ui.TextInput(c, &d.Branch).FillWidth().Placeholder("chore/deps-auto").Label(tr(c, "schedBranch"))
					})
				})
			})
			field(tr(c, "factMode"), func() {
				st.Seg(c, &d.Mode, tr(c, "modeAsk"), tr(c, "modeAuto"), tr(c, "modePlan"))
			})
		})
		st.HRule(c)
		ui.Row(c).FillWidth().Padding(12, 20).Gap(8).AlignItems(ui.Center).Background(st.Side).Children(func() {
			ui.Icon(c, kit.IconInfo).FontSize(13).TextColor(st.Text3)
			ui.Text(c, tr(c, "schedNotRunYet")).FontSize(st.FontSmall).TextColor(st.Text3).Shrink(1)
			ui.Spacer(c)
			st.Btn(c, kit.Button{Label: tr(c, "dialogCancel"), Small: true}, closeIt)
			st.Btn(c, kit.Button{Label: tr(c, "schedCreate"), Kind: kit.ButtonPrimary, Small: true}, func() {
				a.Dispatch(app.AddTask{})
			})
		})
	})
}
