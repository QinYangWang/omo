package view

import (
	"fmt"
	"runtime"
	"strings"

	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/kit"
	"github.com/egoist/mygo/ui"
)

// Version is the app's version as Settings → About shows it.
const Version = "0.1.0"

type settingsPage struct {
	id    string
	icon  *ui.SVG
	key   string
	group string
}

var settingsPages = []settingsPage{
	{app.SetPrefs, kit.IconSliders, "setPrefs", "setGroupGeneral"},
	{app.SetGeneral, kit.IconSettings, "setGeneral", "setGroupGeneral"},
	{app.SetAppear, kit.IconPalette, "setAppear", "setGroupGeneral"},
	{app.SetKeys, kit.IconKeyboard, "setKeys", "setGroupGeneral"},
	{app.SetAgents, kit.IconBot, "setAgents", "setGroupAgent"},
	{app.SetRoles, kit.IconUser, "setRoles", "setGroupAgent"},
	{app.SetMemory, kit.IconBrain, "setMemory", "setGroupAgent"},
	{app.SetMCP, kit.IconPlug, "setMCP", "setGroupAgent"},
	{app.SetPrompts, kit.IconHash, "setPrompts", "setGroupAgent"},
	{app.SetProjects, kit.IconFolder, "setProjects", "setGroupWorkspace"},
	{app.SetGitHub, kit.IconPullRequest, "setGitHub", "setGroupWorkspace"},
	{app.SetShare, kit.IconShare, "setShare", "setGroupWorkspace"},
	{app.SetUsage, kit.IconChart, "setUsage", "setGroupAccount"},
	{app.SetAbout, kit.IconInfo, "setAbout", "setGroupAccount"},
}

// settingsWindow covers the window: the grouped navigation at the left and
// the page, centered, at the right.
func settingsWindow(c *ui.Context, a *app.App, st kit.Theme) {
	settingsNav(c, a, st)
	st.VRule(c)
	ui.Column(c).Grow(1).FillHeight().Children(func() {
		header(c, st, 20, func() {
			ui.Spacer(c)
			themeButton(c, a, st)
			st.IconButton(c, kit.IconX, tr(c, "close"), false, func() { a.Dispatch(app.CloseSettings{}) })
		})
		width := st.ColumnW
		if a.Layout.SettingsPage == app.SetAgents || a.Layout.SettingsPage == app.SetPrompts {
			width = 900
		}
		ui.Scroll(c).Grow(1).Children(func() {
			ui.Column(c).FillWidth().AlignItems(ui.Center).Padding(10, 24, 40, 24).Children(func() {
				ui.Column(c).Width(width).MaxWidthPercent(100).Children(func() { settingsPageBody(c, a, st) })
			})
		})
	})
	c.OnShortcut(0, ui.KeyEscape, func() { a.Dispatch(app.CloseSettings{}) })
}

func settingsNav(c *ui.Context, a *app.App, st kit.Theme) {
	bar := c.TitleBar()
	ui.Column(c).Width(st.SettingsNavW).FillHeight().Background(st.Side).Children(func() {
		ui.Row(c).Height(st.HeadH).Padding(0, 10, 0, bar.Left+12).Gap(8).AlignItems(ui.Center).DragWindow().Children(func() {
			st.IconButton(c, kit.IconChevronLeft, tr(c, "setBack"), false, func() { a.Dispatch(app.CloseSettings{}) })
			ui.Text(c, tr(c, "cmdSettings")).FontSize(st.FontUI).FontWeight(600).TextColor(st.Text)
		})
		ui.Row(c).PaddingX(12).Children(func() {
			ui.SearchField(c, &a.Layout.SettingsQuery).Grow(1).Label(tr(c, "setSearch")).Placeholder(tr(c, "setSearch"))
		})
		q := strings.ToLower(strings.TrimSpace(a.Layout.SettingsQuery))
		ui.Scroll(c).Grow(1).Children(func() {
			ui.Column(c).FillWidth().Padding(4, 8, 8, 8).Children(func() {
				group := ""
				for _, p := range settingsPages {
					p := p
					label := tr(c, p.key)
					if q != "" && !strings.Contains(strings.ToLower(label), q) {
						continue
					}
					if p.group != group {
						group = p.group
						ui.Row(c).Height(30).Padding(10, 8, 2, 8).AlignItems(ui.Center).Children(func() {
							ui.Text(c, tr(c, group)).FontSize(st.FontMeta).FontWeight(500).TextColor(st.Text3)
						})
					}
					st.NavItem(c, p.icon, label, "", a.Layout.SettingsPage == p.id, func() {
						a.Dispatch(app.OpenSettings{Page: p.id})
					})
				}
			})
		})
		ui.Row(c).Height(36).PaddingX(12).AlignItems(ui.Center).Children(func() {
			ui.Text(c, "omo "+Version+" · ACP 1").FontSize(st.FontMeta).TextColor(st.Text3)
		})
	})
}

func pageHead(c *ui.Context, st kit.Theme, titleKey, leadKey string, action func()) {
	ui.Row(c).FillWidth().Padding(20, 0, 4, 0).AlignItems(ui.End).Gap(12).Children(func() {
		ui.Column(c).Grow(1).Gap(4).Children(func() {
			ui.Text(c, tr(c, titleKey)).FontSize(st.FontH1).FontWeight(600).LetterSpacing(-0.3).TextColor(st.Text)
			ui.Text(c, tr(c, leadKey)).FontSize(st.FontUI).TextColor(st.Text2)
		})
		if action != nil {
			action()
		}
	})
}

func h2(c *ui.Context, st kit.Theme, key string) {
	ui.Text(c, tr(c, key)).FontSize(st.FontSmall).FontWeight(500).TextColor(st.Text3).Padding(22, 0, 8, 0)
}

func settingsPageBody(c *ui.Context, a *app.App, st kit.Theme) {
	p := a.Prefs()
	switch a.Layout.SettingsPage {
	case app.SetGeneral:
		pageGeneral(c, a, st, p)
	case app.SetAppear:
		pageAppearance(c, a, st, p)
	case app.SetKeys:
		pageKeys(c, st)
	case app.SetAgents:
		pageAgents(c, a, st, p)
	case app.SetRoles:
		pageEmpty(c, st, "setRoles", "setRolesLead", kit.IconUser, "setRolesEmpty", "setRolesEmptyHint")
	case app.SetMemory:
		pageMemory(c, st, p)
	case app.SetMCP:
		pageMCP(c, st, p)
	case app.SetPrompts:
		pagePrompts(c, a, st, p)
	case app.SetProjects:
		pageProjects(c, a, st, p)
	case app.SetGitHub:
		pageGitHub(c, st, p)
	case app.SetShare:
		pageShare(c, st, p)
	case app.SetUsage:
		pageEmpty(c, st, "setUsage", "setUsageLead", kit.IconChart, "setUsageEmpty", "setUsageEmptyHint")
	case app.SetAbout:
		pageAbout(c, a, st)
	default:
		pagePrefs(c, a, st, p)
	}
}

func segRow(c *ui.Context, st kit.Theme, title, desc string, sel *int, keys ...string) {
	st.SettingRow(c, title, desc, func() {
		labels := make([]string, len(keys))
		for i, k := range keys {
			labels[i] = tr(c, k)
		}
		st.Seg(c, sel, labels...)
	})
}

func switchRow(c *ui.Context, st kit.Theme, title, desc string, on *bool) {
	st.SettingRow(c, title, desc, func() { st.Switch(c, on, title) })
}

func selectRow(c *ui.Context, st kit.Theme, title, desc string, sel *int, options ...string) {
	st.SettingRow(c, title, desc, func() { st.SelectBox(c, title, sel, options) })
}

func pagePrefs(c *ui.Context, a *app.App, st kit.Theme, p *app.Prefs) {
	pageHead(c, st, "setPrefs", "setPrefsLead", nil)
	h2(c, st, "setNewSession")
	st.SettingsCard(c,
		func() {
			st.SettingRow(c, tr(c, "setDefaultAgent"), tr(c, "setDefaultAgentHint"), func() {
				defs := a.AgentDefinitions()
				if len(defs) == 0 {
					ui.Text(c, tr(c, "agentUnconfigured")).FontSize(st.FontSmall).TextColor(st.Text3)
					return
				}
				names := make([]string, len(defs))
				sel := 0
				for i, d := range defs {
					names[i] = d.Name
					if d.ID == a.ActiveAgentID() {
						sel = i
					}
				}
				before := sel
				st.SelectBox(c, tr(c, "setDefaultAgent"), &sel, names)
				if sel != before {
					a.Dispatch(app.SelectAgent{ID: defs[sel].ID})
				}
			})
		},
		func() { segRow(c, st, tr(c, "setDefaultMode"), "", &p.SessionMode, "modeAsk", "modeAuto", "modePlan") },
		func() {
			segRow(c, st, tr(c, "setSend"), tr(c, "setSendHint"), &p.SendKey, "setSendEnter", "setSendCtrlEnter")
		},
		func() { segRow(c, st, tr(c, "setInterrupt"), "", &p.Interrupt, "setQueue", "setInterruptNow") },
	)
	h2(c, st, "setNotify")
	st.SettingsCard(c,
		func() { switchRow(c, st, tr(c, "setNotifyAsk"), tr(c, "setNotifyAskHint"), &p.NotifyAsk) },
		func() { switchRow(c, st, tr(c, "setNotifyEnd"), "", &p.NotifyEnd) },
	)
	h2(c, st, "setLanguage")
	st.SettingsCard(c,
		func() {
			selectRow(c, st, tr(c, "setUILanguage"), tr(c, "setUILanguageHint"), &p.Language, tr(c, "langSystem"), "简体中文", "English")
		},
		func() {
			selectRow(c, st, tr(c, "setReplyLanguage"), tr(c, "setReplyLanguageHint"), &p.ReplyLang, tr(c, "langSame"), "简体中文", "English")
		},
	)
}

func pageGeneral(c *ui.Context, a *app.App, st kit.Theme, p *app.Prefs) {
	pageHead(c, st, "setGeneral", "setGeneralLead", nil)
	h2(c, st, "setStartup")
	st.SettingsCard(c,
		func() { switchRow(c, st, tr(c, "setLaunch"), tr(c, "setLaunchHint"), &p.LaunchAtLogin) },
		func() {
			selectRow(c, st, tr(c, "setOpenOnStart"), "", &p.OpenOnStart, tr(c, "setLastSession"), tr(c, "navNewSession"))
		},
		func() { segRow(c, st, tr(c, "setOnClose"), "", &p.OnClose, "setQuit", "setTray") },
	)
	h2(c, st, "setStorage")
	st.SettingsCard(c,
		func() {
			st.SettingRow(c, tr(c, "setData"), "", func() {
				st.Mono(c, app.DataDir(), st.FontSmall, st.Text2)
			})
		},
		func() {
			selectRow(c, st, tr(c, "setLogs"), tr(c, "setLogsHint"), &p.LogDays, "7", "30")
		},
	)
	h2(c, st, "setUpdates")
	st.SettingsCard(c,
		func() { segRow(c, st, tr(c, "setChannel"), "", &p.Channel, "setStable", "setPreview") },
		func() { switchRow(c, st, tr(c, "setAutoUpdate"), tr(c, "setAutoUpdateHint"), &p.AutoUpdate) },
	)
}

func pageAppearance(c *ui.Context, a *app.App, st kit.Theme, p *app.Prefs) {
	pageHead(c, st, "setAppear", "setAppearLead", nil)
	h2(c, st, "setTheme")
	ui.Row(c).FillWidth().Gap(14).Children(func() {
		for _, m := range []struct {
			mode, key string
		}{{"light", "themeLight"}, {"dark", "themeDark"}, {"system", "themeSystem"}} {
			m := m
			on := p.Theme == m.mode
			e := ui.Column(c).Width(230).Gap(8).AlignItems(ui.Center).Focusable().Label(tr(c, m.key))
			e.Children(func() {
				border, bw := st.Border2, float32(1)
				if on {
					border, bw = st.Accent, 2
				}
				ui.Row(c).FillWidth().Height(96).Radius(st.RadiusM).Border(bw, border).Clip().Children(func() {
					themeSwatch(c, m.mode)
				})
				col := st.Text2
				if on {
					col = st.Text
				}
				ui.Text(c, tr(c, m.key)).FontSize(st.FontRow).TextColor(col)
			})
			e.OnClick(func() { a.Dispatch(app.SetTheme{Mode: m.mode}) })
		}
	})
	h2(c, st, "setInterface")
	st.SettingsCard(c,
		func() { segRow(c, st, tr(c, "setFontSize"), "", &p.FontSize, "size12", "size13", "size14") },
		func() {
			selectRow(c, st, tr(c, "setCodeFont"), tr(c, "setCodeFontHint"), &p.CodeFont, "Geist Mono", tr(c, "fontSystemMono"))
		},
	)
	h2(c, st, "setSession")
	st.SettingsCard(c,
		func() { switchRow(c, st, tr(c, "setCollapse"), tr(c, "setCollapseHint"), &p.CollapseReads) },
		func() { segRow(c, st, tr(c, "setDiffView"), "", &p.DiffView, "diffUnified", "diffSplit") },
	)
}

// themeSwatch is a small picture of the window in an appearance: both palettes
// side by side for "system".
func themeSwatch(c *ui.Context, mode string) {
	draw := func(dark bool, grow float32) {
		side, bg, line := ui.Hex("#F3F3F1"), ui.Hex("#FFFFFF"), ui.Hex("#D2D2CD")
		if dark {
			side, bg, line = ui.Hex("#0F1012"), ui.Hex("#131416"), ui.Hex("#34353B")
		}
		ui.Row(c).Grow(grow).Basis(0).MinWidth(0).FillHeight().Background(bg).Clip().Children(func() {
			ui.Column(c).Width(64).FillHeight().Background(side).Padding(10, 8).Gap(6).Children(func() {
				ui.Box(c).Size(36, 4).Radius(2).Background(line)
				ui.Box(c).Size(48, 4).Radius(2).Background(line)
			})
			ui.Column(c).Grow(1).Padding(12, 10).Gap(6).Children(func() {
				ui.Box(c).Size(90, 4).Radius(2).Background(line)
				ui.Box(c).Size(64, 4).Radius(2).Background(line)
			})
		})
	}
	switch mode {
	case "light":
		draw(false, 1)
	case "dark":
		draw(true, 1)
	default:
		draw(false, 1)
		draw(true, 1)
	}
}

func pageKeys(c *ui.Context, st kit.Theme) {
	pageHead(c, st, "setKeys", "setKeysLead", nil)
	row := func(key string, caps ...string) func() {
		return func() { st.SettingRow(c, tr(c, key), "", func() { st.Keys(c, keyCaps(caps...)...) }) }
	}
	h2(c, st, "setKeysApp")
	st.SettingsCard(c,
		row("navNewSession", "Ctrl", "N"),
		row("navSearch", "Ctrl", "K"),
		row("cmdSettings", "Ctrl", ","),
		row("cmdOpenFolder", "Ctrl", "Shift", "O"),
		row("cmdToggleLeft", "Ctrl", "B"),
	)
	h2(c, st, "setKeysSession")
	st.SettingsCard(c,
		row("chatSend", "Enter"),
		row("keysNewline", "Shift", "Enter"),
		row("permAllowOnce", "Enter"),
		row("cmdTogglePanel", "Ctrl", "Shift", "D"),
		row("cmdToggleRight", "Ctrl", "Shift", "C"),
		row("cmdNewTerminal", "Ctrl", "Shift", "T"),
		row("cmdSaveFile", "Ctrl", "S"),
	)
}

// pageAgents is the configured ACP agents: the list at the left, the chosen
// one's launch command, variables and defaults at the right.
func pageAgents(c *ui.Context, a *app.App, st kit.Theme, p *app.Prefs) {
	pageHead(c, st, "setAgents", "setAgentsLead", func() {
		st.Btn(c, kit.Button{Label: tr(c, "agentAdd"), Icon: kit.IconPlus, Small: true}, func() { a.Dispatch(app.EditAgentConfig{}) })
	})
	defs := a.AgentDefinitions()
	if len(defs) == 0 {
		ui.Box(c).Height(20)
		st.Card(c, func() { st.EmptyState(c, kit.IconBot, tr(c, "agentUnconfigured"), tr(c, "agentConfigHint")) })
		return
	}
	sel := a.Layout.AgentSel
	found := false
	for _, d := range defs {
		if d.ID == sel {
			found = true
		}
	}
	if !found {
		sel = defs[0].ID
	}
	states := map[string]string{}
	for _, pr := range a.AgentProcesses() {
		states[pr.ID] = pr.State
	}
	ui.Row(c).FillWidth().Padding(24, 0, 0, 0).Gap(22).AlignItems(ui.Start).Children(func() {
		ui.Column(c).Width(250).Gap(12).Children(func() {
			st.Card(c, func() {
				ui.Column(c).FillWidth().Padding(5).Gap(2).Children(func() {
					for _, d := range defs {
						d := d
						e := ui.Row(c).FillWidth().Height(48).PaddingX(9).Gap(10).Radius(8).AlignItems(ui.Center).
							Focusable().Label(d.Name)
						if d.ID == sel || e.Hovered() {
							e = e.Background(st.Hover)
						}
						tone, label := processState(c, states[d.ID])
						e.Children(func() {
							st.AgentMark(c, d.Name, 22)
							ui.Column(c).Grow(1).Shrink(1).Children(func() {
								ui.Text(c, d.Name).FontSize(st.FontUI).FontWeight(500).TextColor(st.Text).SingleLine()
								ui.Text(c, label).FontSize(st.FontMeta).TextColor(st.Text3).SingleLine()
							})
							if tone != kit.ToneOff {
								st.Dot(c, tone)
							}
						})
						e.OnClick(func() { a.Layout.AgentSel = d.ID })
					}
				})
			})
			ui.Text(c, tr(c, "setAgentsAny")).FontSize(st.FontSmall).TextColor(st.Text3)
		})
		ui.Column(c).Grow(1).Gap(6).Children(func() {
			for _, d := range defs {
				if d.ID != sel {
					continue
				}
				d := d
				ui.Row(c).FillWidth().Gap(12).AlignItems(ui.Center).Padding(0, 0, 10, 0).Children(func() {
					st.AgentMark(c, d.Name, 32)
					ui.Column(c).Grow(1).Children(func() {
						ui.Text(c, d.Name).FontSize(15).FontWeight(600).TextColor(st.Text)
						_, label := processState(c, states[d.ID])
						trust := tr(c, "setUntrusted")
						if d.Trusted {
							trust = tr(c, "setTrusted")
						}
						ui.Text(c, "ACP 1 · "+label+" · "+trust).FontSize(st.FontSmall).TextColor(st.Text3)
					})
					if d.ID == a.ActiveAgentID() && states[d.ID] != "off" {
						st.Btn(c, kit.Button{Label: tr(c, "agentRestart"), Icon: kit.IconRefresh, Small: true},
							func() { a.Dispatch(app.RestartAgent{}) })
					} else {
						st.Btn(c, kit.Button{Label: tr(c, "agentStart"), Icon: kit.IconRun, Small: true}, func() {
							a.Dispatch(app.SelectAgent{ID: d.ID})
							a.Dispatch(app.StartAgent{ID: d.ID})
						})
					}
					st.Btn(c, kit.Button{Label: tr(c, "agentEdit"), Icon: kit.IconPencil, Kind: kit.ButtonGhost, Small: true},
						func() { a.Dispatch(app.EditAgentConfig{ID: d.ID}) })
					if a.AgentUpdatable(d.ID) {
						st.Btn(c, kit.Button{Label: tr(c, "agentUpdate"), Kind: kit.ButtonGhost, Small: true},
							func() { a.Dispatch(app.UpdateAgent{ID: d.ID}) })
					}
					st.IconButton(c, kit.IconTrash, tr(c, "agentDelete"), false, func() { a.Dispatch(app.DeleteAgent{ID: d.ID}) })
				})
				ui.Text(c, tr(c, "setLaunchCmd")).FontSize(st.FontSmall).FontWeight(500).TextColor(st.Text3)
				ui.Row(c).FillWidth().Height(32).PaddingX(10).Radius(7).Background(st.BG).Border(1, st.Border2).
					AlignItems(ui.Center).Children(func() {
					st.Mono(c, homePath(strings.TrimSpace(d.Executable+" "+strings.Join(d.Args, " "))), st.FontSmall, st.Text).SingleLine()
				})
				ui.Text(c, tr(c, "agentEnv")).FontSize(st.FontSmall).FontWeight(500).TextColor(st.Text3).Padding(12, 0, 0, 0)
				if len(d.Env) == 0 {
					ui.Text(c, tr(c, "setNoEnv")).FontSize(st.FontSmall).TextColor(st.Text3)
				} else {
					st.Card(c, func() {
						for i, entry := range d.Env {
							if i > 0 {
								st.HRule(c)
							}
							name, value, _ := strings.Cut(entry, "=")
							ui.Row(c).FillWidth().Height(44).PaddingX(12).Gap(16).AlignItems(ui.Center).Children(func() {
								ui.Box(c).Width(200).Children(func() { st.Mono(c, name, st.FontSmall, st.Text).SingleLine() })
								st.Mono(c, maskValue(name, value), st.FontSmall, st.Text3).SingleLine()
							})
						}
					})
				}
				ui.Text(c, tr(c, "setDefaults")).FontSize(st.FontSmall).FontWeight(500).TextColor(st.Text3).Padding(12, 0, 0, 0)
				st.SettingsCard(c,
					func() {
						segRow(c, st, tr(c, "setDefaultMode"), tr(c, "setModeHint"), &p.SessionMode, "modeAsk", "modeAuto", "modePlan")
					},
					func() {
						selectRow(c, st, tr(c, "setIdle"), tr(c, "setIdleHint"), &p.IdleClose,
							tr(c, "idleNever"), trf(c, "idleMinutes", map[string]any{"n": 10}), trf(c, "idleMinutes", map[string]any{"n": 30}))
					},
				)
			}
		})
	})
}

// maskValue hides what looks like a secret, keeping its last four characters.
func maskValue(name, value string) string {
	upper := strings.ToUpper(name)
	for _, s := range []string{"KEY", "TOKEN", "SECRET", "PASSWORD"} {
		if strings.Contains(upper, s) {
			if len(value) <= 4 {
				return "••••"
			}
			return strings.Repeat("•", 12) + value[len(value)-4:]
		}
	}
	return value
}

func pageEmpty(c *ui.Context, st kit.Theme, title, lead string, icon *ui.SVG, emptyTitle, emptyHint string) {
	pageHead(c, st, title, lead, nil)
	ui.Box(c).Height(20)
	st.Card(c, func() { st.EmptyState(c, icon, tr(c, emptyTitle), tr(c, emptyHint)) })
}

func pageMemory(c *ui.Context, st kit.Theme, p *app.Prefs) {
	pageHead(c, st, "setMemory", "setMemoryLead", nil)
	ui.Box(c).Height(16)
	st.SettingsCard(c,
		func() { switchRow(c, st, tr(c, "setMemoryOn"), "", &p.MemoryOn) },
		func() { switchRow(c, st, tr(c, "setMemoryWrite"), tr(c, "setMemoryWriteHint"), &p.MemoryWrite) },
	)
	h2(c, st, "setMemoryList")
	st.Card(c, func() { st.EmptyState(c, kit.IconBrain, tr(c, "setMemoryEmpty"), tr(c, "setMemoryEmptyHint")) })
}

func pageMCP(c *ui.Context, st kit.Theme, p *app.Prefs) {
	pageHead(c, st, "setMCP", "setMCPLead", nil)
	ui.Box(c).Height(16)
	st.Card(c, func() { st.EmptyState(c, kit.IconPlug, tr(c, "setMCPEmpty"), tr(c, "setMCPEmptyHint")) })
	h2(c, st, "setRules")
	st.SettingsCard(c,
		func() { switchRow(c, st, tr(c, "setMCPAssign"), tr(c, "setMCPAssignHint"), &p.MCPAssign) },
		func() { switchRow(c, st, tr(c, "setMCPApprove"), tr(c, "setMCPApproveHint"), &p.MCPApprove) },
	)
}

// pagePrompts edits the quick commands: the list at the left, the chosen
// one's name and text at the right.
func pagePrompts(c *ui.Context, a *app.App, st kit.Theme, p *app.Prefs) {
	pageHead(c, st, "setPrompts", "setPromptsLead", func() {
		st.Btn(c, kit.Button{Label: tr(c, "setPromptNew"), Icon: kit.IconPlus, Small: true}, func() { a.Dispatch(app.AddPrompt{}) })
	})
	if len(p.Prompts) == 0 {
		ui.Box(c).Height(20)
		st.Card(c, func() { st.EmptyState(c, kit.IconHash, tr(c, "setPromptsEmpty"), "") })
		return
	}
	sel := min(max(a.Layout.PromptSel, 0), len(p.Prompts)-1)
	ui.Row(c).FillWidth().Padding(24, 0, 0, 0).Gap(22).AlignItems(ui.Start).Children(func() {
		ui.Column(c).Width(300).Children(func() {
			st.Card(c, func() {
				ui.Column(c).FillWidth().Padding(5).Gap(2).Children(func() {
					for i, q := range p.Prompts {
						i, q := i, q
						e := ui.Row(c).FillWidth().Height(44).PaddingX(10).Gap(10).Radius(8).AlignItems(ui.Center).Focusable().Label(q.Name)
						if i == sel || e.Hovered() {
							e = e.Background(st.Hover)
						}
						e.Children(func() {
							st.Mono(c, q.Name, st.FontSmall, st.Accent).SingleLine()
							hint := q.Hint
							if hint != "" {
								hint = tr(c, hint)
							}
							ui.Text(c, hint).FontSize(st.FontSmall).TextColor(st.Text3).SingleLine().Shrink(1)
						})
						e.OnClick(func() { a.Layout.PromptSel = i })
					}
				})
			})
		})
		ui.Column(c).Grow(1).Gap(8).Children(func() {
			q := &p.Prompts[sel]
			ui.Text(c, tr(c, "setPromptName")).FontSize(st.FontSmall).FontWeight(500).TextColor(st.Text3)
			ui.TextInput(c, &q.Name).FillWidth().Label(tr(c, "setPromptName"))
			ui.Text(c, tr(c, "setPromptText")).FontSize(st.FontSmall).FontWeight(500).TextColor(st.Text3).Padding(8, 0, 0, 0)
			ui.TextArea(c, &q.Text).FillWidth().Height(160).Label(tr(c, "setPromptText"))
			ui.Row(c).FillWidth().Gap(8).Padding(8, 0, 0, 0).Children(func() {
				st.Btn(c, kit.Button{Label: tr(c, "delete"), Icon: kit.IconTrash, Kind: kit.ButtonGhost, Small: true},
					func() { a.Dispatch(app.DeletePrompt{Index: sel}) })
				ui.Spacer(c)
				st.Btn(c, kit.Button{Label: tr(c, "save"), Kind: kit.ButtonPrimary, Small: true}, a.SavePrefs)
			})
		})
	})
}

func pageProjects(c *ui.Context, a *app.App, st kit.Theme, p *app.Prefs) {
	pageHead(c, st, "setProjects", "setProjectsLead", func() {
		st.Btn(c, kit.Button{Label: tr(c, "setProjectAdd"), Icon: kit.IconPlus, Small: true}, func() { a.Run(app.CmdOpenFolder) })
	})
	ui.Box(c).Height(16)
	projects := a.Projects()
	if len(projects) == 0 {
		st.Card(c, func() { st.EmptyState(c, kit.IconFolder, tr(c, "statusNoWorkspace"), tr(c, "setProjectsEmptyHint")) })
	} else {
		st.Card(c, func() {
			for i, pr := range projects {
				if i > 0 {
					st.HRule(c)
				}
				path := pr.Path
				open := path == a.WorkspacePath()
				ui.Row(c).FillWidth().Height(56).PaddingX(16).Gap(12).AlignItems(ui.Center).Children(func() {
					icon := kit.IconFolder
					if open {
						icon = kit.IconFolderOpen
					}
					ui.Icon(c, icon).FontSize(16).TextColor(st.Text2)
					ui.Column(c).Grow(1).Shrink(1).Children(func() {
						ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
							ui.Text(c, pr.Name).FontSize(st.FontUI).FontWeight(600).TextColor(st.Text)
							if open && a.Branch() != "" {
								st.Mono(c, a.Branch(), st.FontMeta, st.Text3)
							}
						})
						st.Mono(c, homePath(path), st.FontSmall, st.Text3).SingleLine()
					})
					ui.Text(c, trf(c, "setProjectSessions", map[string]any{"count": a.SessionCount(path)})).
						FontSize(st.FontSmall).TextColor(st.Text3)
					if !open {
						st.Btn(c, kit.Button{Label: tr(c, "open"), Small: true}, func() { a.Dispatch(app.OpenProject{Path: path}) })
					}
				})
			}
		})
	}
	if a.WorkspaceName() == "" {
		return
	}
	ui.Text(c, trf(c, "setProjectSettings", map[string]any{"name": a.WorkspaceName()})).FontSize(st.FontSmall).
		FontWeight(500).TextColor(st.Text3).Padding(22, 0, 8, 0)
	st.SettingsCard(c,
		func() { switchRow(c, st, tr(c, "setWorktrees"), tr(c, "setWorktreesHint"), &p.Worktrees) },
		func() { segRow(c, st, tr(c, "setOutside"), "", &p.OutsideRoot, "setAlwaysAsk", "setDeny") },
	)
}

func pageGitHub(c *ui.Context, st kit.Theme, p *app.Prefs) {
	pageHead(c, st, "setGitHub", "setGitHubLead", nil)
	ui.Box(c).Height(16)
	st.Card(c, func() { st.EmptyState(c, kit.IconPullRequest, tr(c, "setGitHubNone"), tr(c, "setGitHubNoneHint")) })
	h2(c, st, "setPullRequests")
	st.SettingsCard(c,
		func() { switchRow(c, st, tr(c, "setDraftPR"), "", &p.DraftPR) },
		func() { switchRow(c, st, tr(c, "setPRLink"), tr(c, "setPRLinkHint"), &p.PRLink) },
	)
	h2(c, st, "setChecks")
	st.SettingsCard(c,
		func() { switchRow(c, st, tr(c, "setCheckNotify"), "", &p.CheckNotify) },
		func() { switchRow(c, st, tr(c, "setCheckFix"), tr(c, "setCheckFixHint"), &p.CheckFix) },
	)
}

func pageShare(c *ui.Context, st kit.Theme, p *app.Prefs) {
	pageHead(c, st, "setShare", "setShareLead", nil)
	h2(c, st, "setShared")
	st.Card(c, func() { st.EmptyState(c, kit.IconShare, tr(c, "setShareEmpty"), tr(c, "setShareEmptyHint")) })
	h2(c, st, "setDefaultsShare")
	st.SettingsCard(c,
		func() { segRow(c, st, tr(c, "setShareWho"), "", &p.ShareWho, "setShareLink", "setShareTeam") },
		func() { switchRow(c, st, tr(c, "setShareTerm"), "", &p.ShareTerm) },
		func() { switchRow(c, st, tr(c, "setShareRedact"), tr(c, "setShareRedactHint"), &p.ShareRedact) },
	)
}

func pageAbout(c *ui.Context, a *app.App, st kit.Theme) {
	ui.Row(c).FillWidth().Padding(24, 0, 8, 0).Gap(16).AlignItems(ui.Center).Children(func() {
		ui.Box(c).Size(56, 56).Radius(14).Background(st.Surface).Border(1, st.Border2).Justify(ui.Center).AlignItems(ui.Center).
			Children(func() { ui.Box(c).Size(22, 22).Radius(6).Background(st.Accent) })
		ui.Column(c).Grow(1).Gap(2).Children(func() {
			ui.Text(c, "omo").Font(kit.FontMono).FontSize(22).FontWeight(600).TextColor(st.Text)
			ui.Text(c, tr(c, "appTagline")).FontSize(st.FontUI).TextColor(st.Text2)
			ui.Text(c, trf(c, "setVersion", map[string]any{"version": Version})).FontSize(st.FontSmall).TextColor(st.Text3)
		})
	})
	h2(c, st, "setEnv")
	names := make([]string, 0, len(a.AgentDefinitions()))
	for _, d := range a.AgentDefinitions() {
		names = append(names, d.Name)
	}
	installed := strings.Join(names, ", ")
	if installed == "" {
		installed = "—"
	}
	diag := fmt.Sprintf("omo %s · ACP 1\n%s/%s\n%s", Version, runtime.GOOS, runtime.GOARCH, installed)
	st.SettingsCard(c,
		func() {
			st.SettingRow(c, tr(c, "setSystem"), "", func() { st.Mono(c, runtime.GOOS+" · "+runtime.GOARCH, st.FontSmall, st.Text2) })
		},
		func() {
			st.SettingRow(c, tr(c, "setInstalled"), "", func() {
				ui.Text(c, installed).FontSize(st.FontSmall).TextColor(st.Text2).SingleLine()
			})
		},
		func() {
			st.SettingRow(c, tr(c, "setData"), "", func() { st.Mono(c, app.DataDir(), st.FontSmall, st.Text2) })
		},
	)
	ui.Row(c).FillWidth().Gap(8).Padding(16, 0, 0, 0).Children(func() {
		st.Btn(c, kit.Button{Label: tr(c, "setCopyDiag"), Icon: kit.IconCopy, Small: true}, func() { c.WriteClipboard(diag) })
		st.Btn(c, kit.Button{Label: tr(c, "setLicenses"), Kind: kit.ButtonGhost, Small: true}, func() {
			a.Dispatch(app.OpenURL{URL: "https://github.com/QinYangWang/omo"})
		})
	})
}
