package view

import (
	"fmt"

	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/kit"
	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/editor"
)

// inspector is the 300 DIP column of a session: the ACP plan, the facts of
// this session, and what the agent changed.
func inspector(c *ui.Context, a *app.App, st kit.Theme) {
	ui.Column(c).Width(st.InspectorW).FillHeight().Children(func() {
		ui.Scroll(c).Grow(1).Children(func() {
			ui.Column(c).FillWidth().Padding(16).Gap(26).Children(func() {
				planSection(c, a, st)
				sessionFacts(c, a, st)
				changesSection(c, a, st)
			})
		})
		if a.AgentChangeCount() > 0 {
			st.HRule(c)
			ui.Row(c).FillWidth().Padding(14, 16).Children(func() {
				ui.Column(c).Grow(1).Children(func() {
					st.Btn(c, kit.Button{Label: tr(c, "inspectorAllChanges"), Icon: kit.IconFileDiff, Small: true, Width: 267},
						func() { a.Dispatch(app.ToggleSidePanel{Name: app.PanelChanges}) })
				})
			})
		}
	})
}

func inspectorTitle(c *ui.Context, st kit.Theme, title string, right func()) {
	ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Padding(0, 0, 8, 0).Children(func() {
		ui.Text(c, title).FontSize(st.FontUI).FontWeight(600).TextColor(st.Text)
		if right != nil {
			right()
		}
	})
}

// planSection is the agent's ACP plan: done steps struck through, the step in
// progress on the accent tint (amber when it waits for an approval), the rest
// to do.
func planSection(c *ui.Context, a *app.App, st kit.Theme) {
	plan := a.Plan()
	done := 0
	for _, e := range plan {
		if e.Status == "completed" {
			done++
		}
	}
	ui.Column(c).FillWidth().Children(func() {
		inspectorTitle(c, st, tr(c, "inspectorPlan"), func() {
			if len(plan) > 0 {
				st.Mono(c, fmt.Sprintf("%d / %d", done, len(plan)), st.FontSmall, st.Text3)
				ui.Spacer(c)
				st.Bar(c, float32(done)/float32(len(plan)), 72, st.Accent)
			}
		})
		if len(plan) == 0 {
			ui.Text(c, tr(c, "planEmpty")).FontSize(st.FontSmall).TextColor(st.Text3)
			return
		}
		waiting := a.Permission() != nil
		for _, e := range plan {
			e := e
			row := ui.Row(c).FillWidth().Height(30).PaddingX(8).Margin(0, -8, 0, -8).Gap(10).Radius(st.RadiusS).
				AlignItems(ui.Center)
			switch e.Status {
			case "completed":
				row.Children(func() {
					ui.Icon(c, kit.IconCircleCheck).FontSize(15).TextColor(st.OK)
					ui.Text(c, e.Content).FontSize(st.FontRow).TextColor(st.Text3).Strikethrough().SingleLine().Shrink(1)
				})
			case "in_progress":
				col := st.Accent
				if waiting {
					col = st.Warn
					row = row.Background(st.WarnBg)
				} else {
					row = row.Background(st.AccentBg)
				}
				row.Children(func() {
					ui.Icon(c, kit.IconCircleDot).FontSize(15).TextColor(col)
					ui.Text(c, e.Content).FontSize(st.FontRow).TextColor(st.Text).SingleLine().Shrink(1)
					if waiting {
						ui.Spacer(c)
						st.Tag(c, nil, tr(c, "stateWaitingShort"), kit.ToneWarn)
					}
				})
			default:
				row.Children(func() {
					ui.Icon(c, kit.IconCircle).FontSize(15).TextColor(st.Text3)
					ui.Text(c, e.Content).FontSize(st.FontRow).TextColor(st.Text2).SingleLine().Shrink(1)
				})
			}
		}
	})
}

func factRow(c *ui.Context, st kit.Theme, label string, value func()) {
	ui.Row(c).FillWidth().MinHeight(28).Gap(10).AlignItems(ui.Center).Children(func() {
		ui.Box(c).Width(76).Children(func() {
			ui.Text(c, label).FontSize(st.FontRow).TextColor(st.Text3).SingleLine()
		})
		ui.Row(c).Grow(1).Gap(8).AlignItems(ui.Center).Children(value)
	})
}

// sessionFacts is "本会话": the agent and its state, the mode, the tool calls
// and the MCP servers handed to it.
func sessionFacts(c *ui.Context, a *app.App, st kit.Theme) {
	ui.Column(c).FillWidth().Gap(2).Children(func() {
		inspectorTitle(c, st, tr(c, "inspectorSession"), nil)
		factRow(c, st, tr(c, "factAgent"), func() {
			name := a.ActiveAgentName()
			if name == "" {
				ui.Text(c, "—").FontSize(st.FontRow).TextColor(st.Text3)
				return
			}
			st.AgentMark(c, name, 14)
			ui.Text(c, name).FontSize(st.FontRow).TextColor(st.Text).SingleLine()
			tone, label := processState(c, agentProcState(a))
			st.Dot(c, tone)
			st.Mono(c, label, st.FontMeta, st.Text3)
		})
		factRow(c, st, tr(c, "factMode"), func() {
			st.Seg(c, &a.Prefs().SessionMode, tr(c, "modeAsk"), tr(c, "modeAuto"), tr(c, "modePlan"))
		})
		factRow(c, st, tr(c, "factTools"), func() {
			total, waiting := a.ToolCalls()
			text := trf(c, "factToolsAll", map[string]any{"count": total})
			if waiting > 0 {
				text = trf(c, "factToolsWaiting", map[string]any{"count": total, "waiting": waiting})
			}
			ui.Text(c, text).FontSize(st.FontRow).TextColor(st.Text).SingleLine()
		})
		factRow(c, st, "MCP", func() {
			ui.Text(c, tr(c, "factMCPNone")).FontSize(st.FontRow).TextColor(st.Text3).SingleLine()
		})
	})
}

func agentProcState(a *app.App) string {
	for _, p := range a.AgentProcesses() {
		if p.ID == a.ActiveAgentID() {
			return p.State
		}
	}
	return "off"
}

// changesSection lists what the agent changed, colored by what happened.
func changesSection(c *ui.Context, a *app.App, st kit.Theme) {
	changes := a.AgentChanges()
	ui.Column(c).FillWidth().Gap(2).Children(func() {
		inspectorTitle(c, st, tr(c, "inspectorChanges"), func() {
			if len(changes) == 0 {
				return
			}
			ui.Spacer(c)
			added, deleted := a.ChangeTotals()
			st.Mono(c, plus(added), st.FontSmall, st.OK)
			st.Mono(c, minus(deleted), st.FontSmall, st.Err)
		})
		if len(changes) == 0 {
			ui.Text(c, tr(c, "changesNone")).FontSize(st.FontSmall).TextColor(st.Text3)
			return
		}
		for _, ch := range changes {
			rel := ch.Rel
			status := ch.Status()
			e := ui.Row(c).FillWidth().Height(24).Gap(8).AlignItems(ui.Center).Focusable().Label(rel)
			e.Children(func() {
				icon := kit.IconFileDiff
				switch status {
				case "A":
					icon = kit.IconFilePlus
				case "D":
					icon = kit.IconFileMinus
				}
				ui.Icon(c, icon).FontSize(14).TextColor(st.StatusColor(status))
				st.Mono(c, rel, st.FontSmall, st.Text2).SingleLine().Shrink(1)
			})
			e.OnClick(func() {
				a.Dispatch(app.OpenDiff{Path: rel})
				a.Dispatch(app.ToggleSidePanel{Name: app.PanelChanges})
			})
		}
	})
}

// sidePanel is the 520 DIP panel: the changes with their diff and a commit
// box, the project's files with a preview, or the terminals.
func sidePanel(c *ui.Context, a *app.App, st kit.Theme) {
	ui.Column(c).Width(st.PanelW).FillHeight().Children(func() {
		ui.Row(c).Height(st.HeadH-4).FillWidth().Padding(0, 12, 0, 12).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Row(c).Padding(2).Gap(2).Radius(7).Background(st.Side).Border(1, st.Border).Children(func() {
				panelTab(c, a, st, app.PanelChanges, kit.IconFileDiff,
					trf(c, "panelChangesCount", map[string]any{"count": a.AgentChangeCount()}))
				panelTab(c, a, st, app.PanelFiles, kit.IconFolder, tr(c, "panelFiles"))
				panelTab(c, a, st, app.PanelTerminal, kit.IconTerminalSquare, tr(c, "panelTerminal"))
			})
			ui.Spacer(c)
			if a.Layout.SidePanel == app.PanelChanges {
				added, deleted := a.ChangeTotals()
				st.Mono(c, plus(added), st.FontSmall, st.OK)
				st.Mono(c, minus(deleted), st.FontSmall, st.Err)
			}
			st.IconButton(c, kit.IconX, tr(c, "panelClose"), false, func() {
				a.Dispatch(app.ToggleSidePanel{Name: a.Layout.SidePanel})
			})
		})
		st.HRule(c)
		switch a.Layout.SidePanel {
		case app.PanelFiles:
			filesPage(c, a, st)
		case app.PanelTerminal:
			terminalPage(c, a, st)
		default:
			changesPage(c, a, st)
		}
	})
}

func panelTab(c *ui.Context, a *app.App, st kit.Theme, name string, icon *ui.SVG, label string) {
	on := a.Layout.SidePanel == name
	e := ui.Row(c).Height(24).PaddingX(9).Gap(5).Radius(5).AlignItems(ui.Center).Focusable().Label(label)
	col := st.Text2
	if on {
		e = e.Background(st.Surface).Border(1, st.Border2)
		col = st.Text
	} else if e.Hovered() {
		col = st.Text
	}
	e.Children(func() {
		ui.Icon(c, icon).FontSize(13).TextColor(col)
		ui.Text(c, label).FontSize(st.FontSmall).TextColor(col).SingleLine()
	})
	e.OnClick(func() {
		if !on {
			a.Dispatch(app.ToggleSidePanel{Name: name})
		}
	})
}

// changesPage lists the agent's changes; the open one shows its diff, and the
// foot commits them or puts everything back.
func changesPage(c *ui.Context, a *app.App, st kit.Theme) {
	changes := a.AgentChanges()
	if len(changes) == 0 {
		ui.Column(c).Grow(1).FillWidth().Children(func() {
			st.EmptyState(c, kit.IconFileDiff, tr(c, "changesNone"), tr(c, "changesNoneHint"))
		})
		return
	}
	active := a.TabAt(a.Layout.ActiveTab)
	activeRel := ""
	if active != nil && active.Kind == app.TabDiff {
		activeRel = active.Rel
	}
	ui.Column(c).FillWidth().Padding(6).Gap(1).Children(func() {
		for _, ch := range changes {
			rel := ch.Rel
			status := ch.Status()
			icon := kit.IconFileDiff
			switch status {
			case "A":
				icon = kit.IconFilePlus
			case "D":
				icon = kit.IconFileMinus
			}
			meta := plus(ch.Added)
			metaClr := st.OK
			if ch.Added == 0 && ch.Deleted > 0 {
				meta, metaClr = minus(ch.Deleted), st.Err
			}
			st.Row(c, kit.RowSpec{
				Icon: icon, IconClr: st.StatusColor(status), Label: rel, Mono: true,
				Meta: meta, MetaClr: metaClr, Badge: status, Active: rel == activeRel, Tip: rel,
				OnClick: func() { a.Dispatch(app.OpenDiff{Path: rel}) },
			})
		}
	})
	st.HRule(c)
	ui.Column(c).Grow(1).FillWidth().Children(func() {
		if active == nil || active.Kind != app.TabDiff || active.Diff == nil {
			st.EmptyState(c, kit.IconFileDiff, "", tr(c, "changesPick"))
			return
		}
		ui.Row(c).Height(36).FillWidth().PaddingX(14).Gap(8).AlignItems(ui.Center).Children(func() {
			st.Mono(c, active.Rel, st.FontSmall, st.Text).SingleLine().Shrink(1)
			for _, ch := range changes {
				if ch.Rel == active.Rel {
					switch ch.Status() {
					case "A":
						st.Tag(c, nil, tr(c, "fileNew"), kit.ToneOK)
					case "D":
						st.Tag(c, nil, tr(c, "fileDeleted"), kit.ToneErr)
					default:
						st.Tag(c, nil, tr(c, "fileModified"), kit.ToneWarn)
					}
				}
			}
			ui.Spacer(c)
			rel := active.Rel
			st.IconButton(c, kit.IconExternal, tr(c, "fileOpen"), false, func() {
				a.Dispatch(app.OpenFile{Path: rel})
				a.Dispatch(app.ToggleSidePanel{Name: app.PanelFiles})
			})
		})
		st.HRule(c)
		active.Diff.Theme = st.EditorTheme(c)
		if a.Prefs().DiffView == 1 {
			active.Diff.Layout = editor.DiffSplit
		} else {
			active.Diff.Layout = editor.DiffUnified
		}
		editor.DiffView(c, active.Diff).Grow(1)
	})
	st.HRule(c)
	ui.Column(c).FillWidth().Padding(12).Gap(8).Children(func() {
		ui.TextInput(c, &a.Layout.CommitMsg).FillWidth().Placeholder(tr(c, "commitPlaceholder")).
			Label(tr(c, "commitPlaceholder"))
		ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
			st.Btn(c, kit.Button{Label: tr(c, "reviewRejectAll"), Icon: kit.IconUndo, Kind: kit.ButtonGhost, Small: true},
				func() { a.Dispatch(app.RejectReview{}) })
			ui.Spacer(c)
			st.Btn(c, kit.Button{Label: tr(c, "reviewAcceptAll"), Small: true}, func() { a.Dispatch(app.AcceptReview{}) })
			if a.Branch() != "" {
				st.Btn(c, kit.Button{Label: tr(c, "commit"), Icon: kit.IconCommit, Kind: kit.ButtonPrimary, Small: true},
					func() { a.Dispatch(app.CommitChanges{}) })
			}
		})
	})
}

// filesPage is the project's tree and a preview of the file chosen in it.
func filesPage(c *ui.Context, a *app.App, st kit.Theme) {
	if a.WorkspaceName() == "" {
		st.EmptyState(c, kit.IconFolderOpen, tr(c, "explorerNoFolder"), "")
		return
	}
	ui.Row(c).Grow(1).FillWidth().Children(func() {
		ui.Scroll(c).Width(210).FillHeight().Children(func() {
			ui.Column(c).FillWidth().Padding(6).Gap(1).Children(func() { fileRows(c, a, st, a.Files(), 0) })
		})
		st.VRule(c)
		ui.Column(c).Grow(1).FillHeight().Children(func() {
			t := a.TabAt(a.Layout.ActiveTab)
			if t == nil || t.Kind != app.TabFile || t.Editor == nil {
				st.EmptyState(c, kit.IconFile, "", tr(c, "filesPick"))
				return
			}
			ui.Row(c).Height(36).FillWidth().PaddingX(14).Gap(8).AlignItems(ui.Center).Children(func() {
				st.Mono(c, t.Rel, st.FontSmall, st.Text).SingleLine().Shrink(1)
				switch a.GitStatus(t.Rel) {
				case "A":
					st.Tag(c, nil, tr(c, "fileNew"), kit.ToneOK)
				case "M":
					st.Tag(c, nil, tr(c, "fileModified"), kit.ToneWarn)
				}
				if a.Dirty(t.Rel) {
					ui.Spacer(c)
					st.Btn(c, kit.Button{Label: tr(c, "cmdSaveFile"), Small: true}, func() { a.Dispatch(app.SaveFile{}) })
				}
			})
			st.HRule(c)
			t.Editor.Theme = st.EditorTheme(c)
			editor.View(c, t.Editor).Grow(1)
		})
	})
}

// fileRows draws the tree: a folder icon (open or closed) per directory, a file
// icon colored by its git status, and the status letter.
func fileRows(c *ui.Context, a *app.App, st kit.Theme, nodes []*app.FileNode, depth int) {
	indent := float32(depth) * 16
	for _, n := range nodes {
		node := n
		if node.IsDir && node.Name == ".git" {
			continue
		}
		if !node.IsDir {
			rel := node.Rel
			status := a.GitStatus(rel)
			icon, clr := st.FileIcon(node.Name)
			if status != "" {
				clr = st.StatusColor(status)
			}
			t := a.TabAt(a.Layout.ActiveTab)
			st.Row(c, kit.RowSpec{
				Indent: indent, Icon: icon, IconClr: clr, Label: node.Name, Mono: true, Badge: status, Tip: rel,
				Active:  t != nil && t.Kind == app.TabFile && t.Rel == rel,
				OnClick: func() { a.Dispatch(app.OpenFile{Path: rel}) },
			})
			continue
		}
		folder := kit.IconFolder
		if node.Open {
			folder = kit.IconFolderOpen
		}
		st.Row(c, kit.RowSpec{
			Indent: indent, Icon: folder, Label: node.Name, Mono: true, Tip: node.Rel,
			OnClick: func() { node.Open = !node.Open },
		})
		if !node.Open {
			continue
		}
		a.LoadChildren(node)
		if node.LoadErr != "" {
			ui.Text(c, node.LoadErr).FontSize(st.FontMeta).TextColor(st.Err).PaddingX(8)
			continue
		}
		fileRows(c, a, st, node.Children, depth+1)
	}
}

// terminalPage shows the terminals of the project, one at a time.
func terminalPage(c *ui.Context, a *app.App, st kit.Theme) {
	terms := a.Terminals()
	if len(terms) == 0 {
		ui.Column(c).Grow(1).FillWidth().AlignItems(ui.Center).Children(func() {
			st.EmptyState(c, kit.IconTerminalSquare, tr(c, "terminalEmptyTitle"), tr(c, "terminalEmpty"))
			st.Btn(c, kit.Button{Label: tr(c, "terminalNew"), Icon: kit.IconPlus, Small: true}, func() {
				a.Dispatch(app.NewTerminal{})
			})
		})
		return
	}
	ui.Row(c).Height(36).FillWidth().PaddingX(10).Gap(4).AlignItems(ui.Center).Children(func() {
		for i, t := range terms {
			index := i
			label := trf(c, "terminalTitle", map[string]any{"num": t.Num})
			if t.Exited {
				label = trf(c, "terminalExited", map[string]any{"num": t.Num, "code": t.ExitCode})
			}
			on := i == a.Layout.ActiveTerm
			e := ui.Row(c).Height(24).PaddingX(9).Radius(5).AlignItems(ui.Center).Focusable().Label(label)
			col := st.Text2
			if on {
				e = e.Background(st.Selected)
				col = st.Text
			}
			e.Children(func() { ui.Text(c, label).FontSize(st.FontSmall).TextColor(col).SingleLine() })
			e.OnClick(func() { a.Dispatch(app.SelectTerminal{Index: index}) })
		}
		ui.Spacer(c)
		st.IconButton(c, kit.IconPlus, tr(c, "terminalNew"), false, func() { a.Dispatch(app.NewTerminal{}) })
		st.IconButton(c, kit.IconTrash, tr(c, "terminalClose"), false, func() {
			a.Dispatch(app.CloseTerminal{Index: a.Layout.ActiveTerm})
		})
	})
	st.HRule(c)
	if i := a.Layout.ActiveTerm; i >= 0 && i < len(terms) && terms[i].Term != nil {
		// Fill, not Grow: a grown box in a row has no height to hit, so the
		// terminal draws but never takes the pointer or the keyboard.
		ui.Row(c).Fill().Padding(8).Background(st.Code).Children(func() {
			terminal.View(c, terms[i].Term).Fill()
		})
	}
}
