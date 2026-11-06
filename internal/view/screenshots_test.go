package view

import (
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/QinYangWang/omo/internal/agent"
	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/kit"
	"github.com/egoist/mygo/ui"
)

// The screenshots in docs/ui are generated, not taken by hand: the same window
// states, the same demo workspace, on any machine. Run
//
//	OMO_SCREENSHOTS=1 go test ./internal/view -run TestWriteScreenshots
//
// to rewrite them; OMO_PREVIEW=<dir> writes every screen in both appearances
// there instead, named as the Doop frames are (home-dark.png …), to lay beside
// the design. A machine without CJK fonts (a Linux container) draws 中文 as
// nothing: OMO_PREVIEW_CJK names a font file to register, as Windows has
// Microsoft YaHei UI. Without either variable the test does nothing, so
// `go test ./...` never writes to the repository.
func TestWriteScreenshots(t *testing.T) {
	preview := os.Getenv("OMO_PREVIEW")
	if os.Getenv("OMO_SCREENSHOTS") == "" && preview == "" {
		t.Skip("set OMO_SCREENSHOTS=1 to rewrite docs/ui, or OMO_PREVIEW=<dir>")
	}
	if err := kit.RegisterFonts(); err != nil {
		t.Fatal(err)
	}
	if cjk := os.Getenv("OMO_PREVIEW_CJK"); cjk != "" {
		data, err := os.ReadFile(cjk)
		if err != nil {
			t.Fatal(err)
		}
		if err := ui.RegisterFont(data, ""); err != nil {
			t.Fatal(err)
		}
	}
	out := preview
	if out == "" {
		var err error
		if out, err = filepath.Abs(filepath.Join("..", "..", "docs", "ui")); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	root := shotRoot(t)

	for _, s := range shotScreens() {
		for _, dark := range []bool{true, false} {
			name := s.name + "-dark.png"
			if !dark {
				name = s.name + "-light.png"
			}
			if preview == "" {
				// docs/ui keeps every screen dark and the main ones light.
				if !dark && !s.light {
					continue
				}
				name = s.num + "-" + name
			}
			a := shotApp(t, root)
			s.prepare(a)
			tt := ui.NewTester(func(c *ui.Context) { Shell(c, a) }, 1280, 800)
			tt.SetDark(dark)
			tt.SetLocale("zh-Hans")
			tt.SetTitleBar(ui.TitleBar{Height: 48, Right: 138})
			for i := 0; i < 3; i++ {
				tt.Frame()
			}
			f, err := os.Create(filepath.Join(out, name))
			if err != nil {
				t.Fatal(err)
			}
			if err := png.Encode(f, tt.Image()); err != nil {
				t.Fatal(err)
			}
			f.Close()
			a.Shutdown()
		}
	}
}

type shotScreen struct {
	num, name string
	light     bool // also in docs/ui in the light appearance
	prepare   func(a *app.App)
}

// shotScreens are the 28 screens of the design, numbered as its frames.
func shotScreens() []shotScreen {
	settings := func(page string) func(*app.App) {
		return func(a *app.App) { a.Dispatch(app.OpenSettings{Page: page}) }
	}
	return []shotScreen{
		{"01", "home", true, func(a *app.App) {}},
		{"01b", "picker", false, func(a *app.App) { a.Dispatch(app.OpenPicker{}) }},
		{"02", "sess", true, func(a *app.App) { finishedSession(a) }},
		{"02b", "term", false, func(a *app.App) {
			finishedSession(a)
			a.Dispatch(app.ToggleSidePanel{Name: app.PanelTerminal})
		}},
		{"03", "files", false, func(a *app.App) {
			finishedSession(a)
			a.Dispatch(app.OpenFile{Path: "docs/wrangler.toml"})
			a.Dispatch(app.ToggleSidePanel{Name: app.PanelFiles})
		}},
		{"04", "diff", true, func(a *app.App) {
			finishedSession(a)
			a.Dispatch(app.OpenDiff{Path: ".github/workflows/deploy.yml"})
			a.Dispatch(app.ToggleSidePanel{Name: app.PanelChanges})
		}},
		{"05", "palette", false, func(a *app.App) {
			finishedSession(a)
			a.Dispatch(app.OpenSearch{})
			a.Layout.SearchQuery = "docs"
		}},
		{"05b", "palette0", false, func(a *app.App) {
			finishedSession(a)
			a.Dispatch(app.OpenSearch{})
			a.Layout.SearchQuery = "kubernetes 部署"
		}},
		{"06", "sched", false, func(a *app.App) {
			seedTasks(a)
			a.Dispatch(app.ShowScreen{Name: app.ScreenSchedule})
		}},
		{"06b", "sched_new", false, func(a *app.App) {
			seedTasks(a)
			a.Dispatch(app.ShowScreen{Name: app.ScreenSchedule})
			a.Dispatch(app.NewTask{})
			d := a.TaskDraft()
			d.Name, d.Prompt, d.Branch = "周报：本周合并的 PR", "汇总本周合并到 main 的 PR，按模块分组，写成一段周报。", "main"
		}},
		{"07", "set_pref", false, settings(app.SetPrefs)},
		{"08", "set_appear", false, settings(app.SetAppear)},
		{"09", "set_keys", false, settings(app.SetKeys)},
		{"10", "set_general", false, settings(app.SetGeneral)},
		{"11", "set_usage", false, settings(app.SetUsage)},
		{"12", "set_agents", true, settings(app.SetAgents)},
		{"13", "set_projects", false, settings(app.SetProjects)},
		{"14", "set_mcp", false, settings(app.SetMCP)},
		{"15", "set_prompts", false, settings(app.SetPrompts)},
		{"16", "run", true, func(a *app.App) { waitingSession(a) }},
		{"17", "trust", false, func(a *app.App) {
			a.Dispatch(app.SelectAgent{ID: "pi"})
			a.Dispatch(app.StartAgent{ID: "pi"})
		}},
		{"18", "running", false, func(a *app.App) { runningSession(a) }},
		{"19", "error", true, func(a *app.App) { failedSession(a) }},
		{"20", "set_roles", false, settings(app.SetRoles)},
		{"21", "set_memory", false, settings(app.SetMemory)},
		{"22", "set_github", false, settings(app.SetGitHub)},
		{"23", "set_share", false, settings(app.SetShare)},
		{"24", "set_about", false, settings(app.SetAbout)},
	}
}

const shotPrompt = "把 docs 站点改成部署到 Cloudflare Pages，并移除 GitHub Pages 的工作流。构建命令用 build:cloudflare。"

var shotPlan = []agent.PlanEntry{
	{Content: "读取现有的 GitHub Pages 工作流", Status: "completed"},
	{Content: "新增 build:cloudflare 脚本", Status: "completed"},
	{Content: "写入 wrangler.toml", Status: "completed"},
	{Content: "改写 deploy.yml 为 Pages 部署", Status: "in_progress"},
	{Content: "删除 gh-pages 工作流", Status: "pending"},
	{Content: "本地构建验证", Status: "pending"},
}

func tool(id, kind, status string, paths []string, command []string) agent.Event {
	return agent.Event{Kind: agent.EventTool, ToolCallID: id, KindDetail: kind, Text: status, Paths: paths, Command: command}
}

// sessionStart is the first half of the demo session: the agent read the
// project, wrote two files and ran the build.
func sessionStart() []agent.Event {
	return []agent.Event{
		{Kind: agent.EventState, State: agent.StatePrompting},
		{Kind: agent.EventPlan, Plan: shotPlan[:4]},
		{Kind: agent.EventText, Text: "先看一下现在的部署方式和构建脚本。"},
		tool("r1", "read", "completed", []string{".github/workflows/pages.yml"}, nil),
		tool("r2", "read", "completed", []string{"docs/package.json"}, nil),
		tool("r3", "search", "completed", nil, nil),
		{Kind: agent.EventText, Text: "现在用 `gh-pages` 分支发布。我会新增 `build:cloudflare`，写入 `wrangler.toml`，再把 `deploy.yml` 改成 Pages 部署。"},
		tool("e1", "edit", "completed", []string{"docs/wrangler.toml"}, nil),
		tool("x1", "execute", "completed", nil, []string{"pnpm", "--filter", "docs", "build:cloudflare"}),
	}
}

// writeAgentFiles writes what the demo agent changed, after the baseline was
// taken, as an agent's own writes land.
func writeAgentFiles(t testing.TB, a *app.App, root string) {
	dir := filepath.Join(root, "paneui")
	a.NoteAgentPaths("docs/wrangler.toml", ".github/workflows/deploy.yml", ".github/workflows/pages.yml")
	files := map[string]string{
		"docs/wrangler.toml":           "name = \"paneui-docs\"\npages_build_output_dir = \"dist\"\ncompatibility_date = \"2026-10-01\"\n",
		".github/workflows/deploy.yml": "name: deploy\non:\n  push:\n    branches: [main]\njobs:\n  pages:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm --filter docs build:cloudflare\n      - uses: cloudflare/wrangler-action@v3\n        with:\n          command: pages deploy docs/dist --project-name=paneui-docs\n",
	}
	for rel, body := range files {
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(rel)), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Remove(filepath.Join(dir, ".github", "workflows", "pages.yml")); err != nil {
		t.Fatal(err)
	}
}

var shotRootDir string

func finishedSession(a *app.App) {
	a.Dispatch(app.SelectAgent{ID: "claude"})
	writeAgentFiles(shotT, a, shotRootDir)
	evs := append(sessionStart(),
		tool("e2", "edit", "completed", []string{".github/workflows/deploy.yml"}, nil),
		tool("d1", "delete", "completed", []string{".github/workflows/pages.yml"}, nil),
		agent.Event{Kind: agent.EventPlan, Plan: done(shotPlan)},
		agent.Event{Kind: agent.EventText, Text: "完成了。docs 现在由 `deploy.yml` 构建并发布到 Cloudflare Pages，项目名 `paneui-docs`；旧的 GitHub Pages 工作流已删除。本地 `build:cloudflare` 通过。"},
		agent.Event{Kind: agent.EventTurnEnd, StopReason: "end_turn"},
		agent.Event{Kind: agent.EventState, State: agent.StateReady},
	)
	a.Replay(shotPrompt, 3*time.Minute+8*time.Second, evs...)
}

func done(plan []agent.PlanEntry) []agent.PlanEntry {
	out := make([]agent.PlanEntry, len(plan))
	for i, e := range plan {
		e.Status = "completed"
		out[i] = e
	}
	return out
}

func waitingSession(a *app.App) {
	a.Dispatch(app.SelectAgent{ID: "claude"})
	writeAgentFiles(shotT, a, shotRootDir)
	evs := append(sessionStart(),
		tool("e2", "edit", "pending", []string{".github/workflows/deploy.yml"}, nil),
		agent.Event{Kind: agent.EventPermission, RequestID: "1-1", ToolCallID: "e2", KindDetail: "edit",
			Title: "改写 deploy.yml", Paths: []string{".github/workflows/deploy.yml"},
			Options: []agent.PermissionOption{
				{ID: "allow", Name: "Allow", Kind: "allow_once"},
				{ID: "always", Name: "Always", Kind: "allow_always"},
				{ID: "reject", Name: "Reject", Kind: "reject_once"},
			}},
	)
	a.Replay(shotPrompt, time.Minute+52*time.Second, evs...)
}

func runningSession(a *app.App) {
	a.Dispatch(app.SelectAgent{ID: "claude"})
	writeAgentFiles(shotT, a, shotRootDir)
	evs := append(sessionStart(), tool("e2", "edit", "in_progress", []string{".github/workflows/deploy.yml"}, nil))
	a.Replay(shotPrompt, 48*time.Second, evs...)
}

func failedSession(a *app.App) {
	a.Dispatch(app.SelectAgent{ID: "gemini"})
	a.Replay("为 Button 补充无障碍测试：键盘焦点、aria-pressed 和读屏名称。", 0,
		agent.Event{Kind: agent.EventState, State: agent.StateStarting},
		agent.Event{Kind: agent.EventDiagnostic, Text: "登录已过期：Gemini CLI 需要重新验证 Google 账号。"},
		agent.Event{Kind: agent.EventState, State: agent.StateError},
	)
}

func seedTasks(a *app.App) {
	p := a.Prefs()
	p.Tasks = []app.ScheduledTask{
		{Name: "每日依赖巡检", AgentID: "claude", Project: "paneui", Schedule: "schedWeekdays 09:00", Branch: "chore/deps-auto", Mode: 1, Enabled: true,
			Prompt: "检查 paneui 的依赖更新。只升级补丁和次版本，跑一遍测试；全部通过就开草稿 PR，否则把失败原因写进会话。"},
		{Name: "夜间回归测试", AgentID: "codex", Project: "paneui", Schedule: "schedDaily 02:30", Mode: 0, Enabled: true,
			Prompt: "在 main 上跑完整测试和视觉回归，失败时列出用例和截图差异。"},
		{Name: "清理过期预览部署", AgentID: "claude", Project: "ottr", Schedule: "schedWeekly 10:00", Mode: 0, Enabled: false,
			Prompt: "列出 30 天前的预览部署，确认后删除。"},
	}
}

var shotT testing.TB

// shotApp builds an app on the demo project with the demo agents configured:
// the same files and the same agents on any machine.
func shotApp(t *testing.T, root string) *app.App {
	t.Helper()
	shotT = t
	shotRootDir = root
	config := filepath.Join(root, "config")
	if err := os.MkdirAll(filepath.Join(config, "omo"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(filepath.Join(config, "omo", "agents.json"))
	t.Setenv("OMO_CONFIG_DIR", config)
	data := filepath.Join(root, "data")
	_ = os.RemoveAll(data)
	t.Setenv("OMO_DATA_DIR", data)
	project := shotFixture(t, root)

	a := app.New()
	a.SetUserName("汪勤洋")
	if err := a.Restore(); err != nil {
		t.Fatal(err)
	}
	for _, other := range []string{"ottr", "postgo"} {
		dir := filepath.Join(root, other)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		a.Dispatch(app.OpenWorkspace{Path: dir})
	}
	a.Dispatch(app.OpenWorkspace{Path: project})
	for _, def := range []struct{ id, name, bin, args string }{
		{"claude", "Claude Code", "claude-code-acp", ""},
		{"codex", "Codex", "codex-acp", ""},
		{"pi", "Pi", "pi", "--acp"},
		{"gemini", "Gemini CLI", "gemini", "--experimental-acp"},
	} {
		a.Dispatch(app.EditAgentConfig{})
		d := a.AgentConfigForm()
		// A fixed id, so the screens can pick an agent by it.
		d.ID, d.Name, d.Executable, d.Args = def.id, def.name, agentExecutable(t, root, def.bin), def.args
		a.Dispatch(app.SaveAgentConfig{})
	}
	return a
}

// shotRoot is where the demo projects live while the screenshots are taken: a
// fixed path, so the paths the window shows are the same on every run.
func shotRoot(t *testing.T) string {
	t.Helper()
	root := filepath.Join(os.TempDir(), "omo-ui-screenshots")
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	return root
}

// agentExecutable is a dummy program the agents point at. The catalog only
// checks that the path exists, and no process starts before the user trusts
// it.
func agentExecutable(t *testing.T, root, name string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	exe := filepath.Join(root, "bin", name)
	if err := os.MkdirAll(filepath.Dir(exe), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return exe
}

// shotFixture builds the demo project, paneui, fresh for each screen: the same
// files and history on any machine. Without git the project still builds; only
// the branch is missing.
func shotFixture(t *testing.T, root string) string {
	t.Helper()
	dir := filepath.Join(root, "paneui")
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"package.json":                 "{\n  \"name\": \"paneui\",\n  \"private\": true\n}\n",
		"README.md":                    "# paneui\n\nComponents for native panels.\n",
		"docs/package.json":            "{\n  \"name\": \"docs\",\n  \"scripts\": { \"build\": \"astro build\" }\n}\n",
		"docs/astro.config.mjs":        "export default {}\n",
		"packages/ui/src/index.ts":     "export * from './button'\n",
		"packages/ui/src/button.tsx":   "export function Button() { return null }\n",
		".github/workflows/pages.yml":  "name: pages\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: pnpm --filter docs build\n      - uses: peaceiris/actions-gh-pages@v4\n",
		".github/workflows/deploy.yml": "name: deploy\non:\n  push:\n    branches: [main]\njobs:\n  pages:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: pnpm --filter docs build\n",
	}
	for name, body := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := exec.LookPath("git"); err == nil {
		for _, args := range [][]string{
			{"init", "--initial-branch=main", "."},
			{"add", "."},
			{"commit", "-m", "initial"},
		} {
			cmd := exec.Command("git", args...)
			cmd.Dir = dir
			cmd.Env = append(os.Environ(),
				"GIT_AUTHOR_NAME=demo", "GIT_AUTHOR_EMAIL=demo@example.com",
				"GIT_COMMITTER_NAME=demo", "GIT_COMMITTER_EMAIL=demo@example.com",
				"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
			if outp, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("git %v: %v: %s", args, err, outp)
			}
		}
	}
	return dir
}
