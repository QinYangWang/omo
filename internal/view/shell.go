package view

import (
	"time"

	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/kit"
	"github.com/egoist/mygo/ui"
)

// Shell is the whole window: the 252 DIP sidebar and the main area, or the
// settings, which cover both. Floating layers (search, the agent picker,
// dialogs) are drawn last, over everything.
//
// The window's own title bar is hidden: the sidebar's top and the main area's
// 48 DIP header move the window, and leave room for its controls.
func Shell(c *ui.Context, a *app.App) {
	a.NoteFrame()
	st := kit.NewFor(c, kit.Mode(a.Prefs().Theme))
	ui.Row(c).Fill().Background(st.BG).Children(func() {
		if a.Layout.Settings {
			settingsWindow(c, a, st)
			return
		}
		if a.LeftOpen() {
			sidebar(c, a, st)
			st.VRule(c)
		}
		ui.Column(c).Grow(1).FillHeight().Children(func() {
			switch a.Layout.Screen {
			case app.ScreenSession:
				sessionScreen(c, a, st)
			case app.ScreenSchedule:
				scheduleScreen(c, a, st)
			default:
				homeScreen(c, a, st)
			}
		})
	})
	overlays(c, a, st)
}

// windowInset is the room the window controls take at the right of a header.
func windowInset(c *ui.Context) float32 {
	bar := c.TitleBar()
	if bar.Right > 0 {
		return bar.Right + 8
	}
	return 10
}

// header is a 48 DIP bar that moves the window: the main area's title bar.
func header(c *ui.Context, st kit.Theme, left float32, fn func()) {
	ui.Row(c).Height(st.HeadH).FillWidth().Padding(0, windowInset(c), 0, left).Gap(10).AlignItems(ui.Center).
		DragWindow().Children(fn)
}

// sidebar is the left column: the word mark, the three actions, the projects
// with their sessions, the local agent processes and the user.
func sidebar(c *ui.Context, a *app.App, st kit.Theme) {
	bar := c.TitleBar()
	ui.Column(c).Width(st.SideW).FillHeight().Background(st.Side).Children(func() {
		ui.Row(c).Height(st.HeadH).Padding(0, 10, 0, bar.Left+16).Gap(8).AlignItems(ui.Center).DragWindow().
			Children(func() {
				ui.Box(c).Size(10, 10).Radius(3).Background(st.Accent)
				ui.Text(c, "omo").Font(kit.FontMono).FontSize(15).FontWeight(600).TextColor(st.Text)
				ui.Spacer(c)
				st.IconButton(c, kit.IconSidebarLeft, tr(c, "cmdToggleLeft"), false, func() { a.Dispatch(app.ToggleLeft{}) })
			})
		ui.Column(c).PaddingX(8).PaddingY(2).Gap(1).Children(func() {
			st.NavItem(c, kit.IconNewSession, tr(c, "navNewSession"), keys("Ctrl", "N"),
				a.Layout.Screen == app.ScreenHome && !a.Layout.SearchOpen, func() { a.Dispatch(app.NewSession{}) })
			st.NavItem(c, kit.IconSearch, tr(c, "navSearch"), keys("Ctrl", "K"), a.Layout.SearchOpen,
				func() { a.Dispatch(app.OpenSearch{}) })
			st.NavItem(c, kit.IconSchedule, tr(c, "navSchedule"), "", a.Layout.Screen == app.ScreenSchedule,
				func() { a.Dispatch(app.ShowScreen{Name: app.ScreenSchedule}) })
		})
		ui.Scroll(c).Grow(1).Children(func() {
			ui.Column(c).FillWidth().PaddingY(4).Children(func() {
				projectsSection(c, a, st)
				agentsSection(c, a, st)
			})
		})
		st.HRule(c)
		sidebarFooter(c, a, st)
	})
}

func projectsSection(c *ui.Context, a *app.App, st kit.Theme) {
	st.Section(c, tr(c, "sideProjects"), func() {
		st.SmallIconButton(c, kit.IconPlus, tr(c, "cmdOpenFolder"), func() { a.Run(app.CmdOpenFolder) })
	})
	current := a.WorkspacePath()
	if current == "" {
		ui.Column(c).PaddingX(8).Children(func() {
			st.NavItem(c, kit.IconFolderOpen, tr(c, "cmdOpenFolder"), keys("Ctrl", "Shift", "O"), false,
				func() { a.Run(app.CmdOpenFolder) })
		})
	} else {
		projectRow(c, st, kit.IconFolderOpen, a.WorkspaceName(), a.Branch(), true, nil)
		sessionRows(c, a, st)
	}
	for _, p := range a.Projects() {
		if p.Path == current {
			continue
		}
		path := p.Path
		count := ""
		if n := a.SessionCount(path); n > 0 {
			count = itoa(n)
		}
		projectRow(c, st, kit.IconFolder, p.Name, count, false, func() { a.Dispatch(app.OpenProject{Path: path}) })
	}
}

func projectRow(c *ui.Context, st kit.Theme, icon *ui.SVG, name, meta string, open bool, onClick func()) {
	ui.Row(c).PaddingX(8).Children(func() {
		e := ui.Row(c).Height(st.RowH).Grow(1).PaddingX(8).Gap(8).Radius(st.RadiusS).AlignItems(ui.Center).
			Focusable().Label(name)
		col := st.Text2
		if open {
			col = st.Text
		}
		if e.Hovered() {
			e = e.Background(st.Hover)
		}
		e.Children(func() {
			ui.Icon(c, icon).FontSize(15).TextColor(col)
			t := ui.Text(c, name).FontSize(st.FontUI).TextColor(col).SingleLine()
			if open {
				t.FontWeight(500)
				st.Mono(c, meta, st.FontMeta, st.Text3).SingleLine()
				return
			}
			ui.Spacer(c)
			st.Mono(c, meta, st.FontMeta, st.Text3)
		})
		if onClick != nil {
			e.OnClick(onClick)
		}
	})
}

// sessionRows are the open project's sessions, hung from it by a 1 DIP line:
// the agent's mark, the title, and its state at the right.
func sessionRows(c *ui.Context, a *app.App, st kit.Theme) {
	sessions := a.Sessions()
	if len(sessions) == 0 {
		return
	}
	now := time.Now()
	ui.Column(c).Padding(0, 8, 0, 26).Children(func() {
		ui.Column(c).FillWidth().BorderWidth(0, 0, 0, 1).BorderColor(st.Border).Children(func() {
			for _, s := range sessions {
				s := s
				title := s.Title
				if title == "" {
					title = trf(c, "sessionUntitled", map[string]any{"agent": s.AgentName})
				}
				e := ui.Row(c).Height(st.RowH).FillWidth().Padding(0, 8, 0, 14).Gap(9).AlignItems(ui.Center).
					Radius(0, st.RadiusS, st.RadiusS, 0).Focusable().Label(title)
				col := st.Text2
				switch {
				case s.Active:
					e = e.Background(st.Selected)
					col = st.Text
				case e.Hovered():
					e = e.Background(st.Hover)
				}
				e.Children(func() {
					st.AgentMark(c, s.AgentName, 14)
					ui.Text(c, title).FontSize(st.FontUI).TextColor(col).SingleLine().Grow(1).Shrink(1)
					sessionState(c, st, s, now)
				})
				e.OnClick(func() {
					a.Dispatch(app.OpenSearchHit{Hit: app.SearchHit{Kind: "session", AgentID: s.AgentID, Title: s.Title}})
				})
			}
		})
	})
}

func sessionState(c *ui.Context, st kit.Theme, s app.SessionInfo, now time.Time) {
	switch s.State {
	case "running":
		ui.Icon(c, kit.IconLoader).FontSize(12).TextColor(st.Accent)
	case "waiting":
		st.Tag(c, nil, tr(c, "stateWaitingShort"), kit.ToneWarn)
	case "failed":
		st.Dot(c, kit.ToneErr)
	default:
		ui.Text(c, relTime(c, s.UpdatedAt, now)).FontSize(st.FontMeta).TextColor(st.Text3).SingleLine()
	}
}

// agentsSection is "本机 Agent": the ACP agents configured on this machine
// and what each one's process is doing.
func agentsSection(c *ui.Context, a *app.App, st kit.Theme) {
	ui.Box(c).Height(8)
	st.Section(c, tr(c, "sideAgents"), func() {
		st.SmallIconButton(c, kit.IconSettings, tr(c, "setAgents"), func() {
			a.Dispatch(app.OpenSettings{Page: app.SetAgents})
		})
	})
	procs := a.AgentProcesses()
	if len(procs) == 0 {
		ui.Column(c).PaddingX(8).Children(func() {
			st.NavItem(c, kit.IconPlus, tr(c, "agentAdd"), "", false, func() { a.Dispatch(app.EditAgentConfig{}) })
		})
		return
	}
	ui.Column(c).PaddingX(8).Gap(1).Children(func() {
		for _, p := range procs {
			p := p
			e := ui.Row(c).Height(34).FillWidth().PaddingX(8).Gap(10).Radius(st.RadiusS).AlignItems(ui.Center).
				Focusable().Label(p.Name)
			if e.Hovered() {
				e = e.Background(st.Hover)
			}
			e.Children(func() {
				st.AgentMark(c, p.Name, 16)
				ui.Text(c, p.Name).FontSize(st.FontRow).TextColor(st.Text).SingleLine().Grow(1).Shrink(1)
				tone, label := processState(c, p.State)
				st.Dot(c, tone)
				st.Mono(c, label, st.FontMeta, st.Text3).SingleLine()
			})
			e.OnClick(func() {
				a.Layout.AgentSel = p.ID
				a.Dispatch(app.OpenSettings{Page: app.SetAgents})
			})
		}
	})
}

// processState is the dot and the words of an agent process.
func processState(c *ui.Context, state string) (kit.Tone, string) {
	switch state {
	case "running":
		return kit.ToneOK, tr(c, "procRunning")
	case "idle":
		return kit.ToneOK, tr(c, "procIdle")
	case "starting":
		return kit.ToneAccent, tr(c, "procStarting")
	case "failed":
		return kit.ToneErr, tr(c, "procFailed")
	}
	return kit.ToneOff, tr(c, "procOff")
}

func sidebarFooter(c *ui.Context, a *app.App, st kit.Theme) {
	ui.Row(c).Height(52).Padding(0, 10, 0, 14).Gap(8).AlignItems(ui.Center).Children(func() {
		name := a.UserName()
		st.Avatar(c, name, 24)
		ui.Column(c).Grow(1).Shrink(1).Children(func() {
			ui.Text(c, name).FontSize(st.FontRow).TextColor(st.Text).SingleLine()
			ui.Text(c, trf(c, "sideMachine", map[string]any{"count": len(a.AgentDefinitions())})).
				FontSize(st.FontMeta).TextColor(st.Text3).SingleLine()
		})
		st.IconButton(c, kit.IconSettings, tr(c, "cmdSettings"), false, func() { a.Dispatch(app.OpenSettings{}) })
		themeButton(c, a, st)
	})
}

// themeButton switches to the other appearance; Settings → Appearance can go
// back to following the system.
func themeButton(c *ui.Context, a *app.App, st kit.Theme) {
	icon, mode := kit.IconSun, kit.ModeLight
	if !st.Dark {
		icon, mode = kit.IconMoon, kit.ModeDark
	}
	st.IconButton(c, icon, tr(c, "cmdToggleTheme"), false, func() { a.Dispatch(app.SetTheme{Mode: string(mode)}) })
}

func itoa(n int) string {
	if n < 0 {
		return "-" + itoa(-n)
	}
	if n < 10 {
		return string(rune('0' + n))
	}
	return itoa(n/10) + string(rune('0'+n%10))
}
