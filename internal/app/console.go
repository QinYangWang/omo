package app

import (
	"encoding/json"
	"os"
	"os/user"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/QinYangWang/omo/internal/agent"
	"github.com/QinYangWang/omo/internal/commands"
	"github.com/QinYangWang/omo/internal/i18n"
	"github.com/QinYangWang/omo/internal/persistence"
)

// The main area shows one of these screens (docs/ui.md, "Screens").
const (
	// ScreenHome is the new-session screen: the question, the composer and
	// the recent sessions.
	ScreenHome = "home"
	// ScreenSession is the conversation with the active agent.
	ScreenSession = "session"
	// ScreenSchedule is the scheduled tasks page.
	ScreenSchedule = "schedule"
)

// The pages of the 520 DIP side panel of a session.
const (
	PanelChanges  = "changes"
	PanelFiles    = "files"
	PanelTerminal = "terminal"
)

// The settings pages, in the order of the navigation.
const (
	SetPrefs     = "prefs"
	SetGeneral   = "general"
	SetAppear    = "appearance"
	SetKeys      = "keys"
	SetAgents    = "agents"
	SetRoles     = "roles"
	SetMemory    = "memory"
	SetMCP       = "mcp"
	SetPrompts   = "prompts"
	SetProjects  = "projects"
	SetGitHub    = "github"
	SetShare     = "share"
	SetUsage     = "usage"
	SetAbout     = "about"
	prefsUIKey   = "prefs"
	titleUIKey   = "title:"
	maxTitleRune = 48
)

// Prefs are the choices of Settings and of the composer. They are saved in
// the metadata store as one JSON value and bound to directly by the settings
// widgets, as Layout is. Fields marked "stored only" are kept and shown but
// not yet acted on: docs/roadmap.md lists them.
type Prefs struct {
	// Theme is kit.Mode: system, light or dark.
	Theme string `json:"theme"`
	// FontSize indexes 12/13/14 DIP interface text (stored only).
	FontSize int `json:"fontSize"`
	// CodeFont indexes the code font list (stored only).
	CodeFont int `json:"codeFont"`
	// CollapseReads folds consecutive read and search tool calls into one row.
	CollapseReads bool `json:"collapseReads"`
	// DiffView is 0 for unified diffs in the side panel, 1 for split.
	DiffView int `json:"diffView"`
	// SessionMode is the default mode: 0 ask, 1 auto edit, 2 plan only
	// (stored only: ACP session/set_mode is not wired yet).
	SessionMode int `json:"sessionMode"`
	// SendKey: 0 Enter sends, 1 Ctrl+Enter sends (stored only).
	SendKey   int  `json:"sendKey"`
	Interrupt int  `json:"interrupt"`
	NotifyAsk bool `json:"notifyAsk"`
	NotifyEnd bool `json:"notifyEnd"`
	Language  int  `json:"language"`
	ReplyLang int  `json:"replyLang"`

	LaunchAtLogin bool `json:"launchAtLogin"`
	OpenOnStart   int  `json:"openOnStart"`
	OnClose       int  `json:"onClose"`
	LogDays       int  `json:"logDays"`
	Channel       int  `json:"channel"`
	AutoUpdate    bool `json:"autoUpdate"`

	IdleClose   int  `json:"idleClose"`
	MemoryOn    bool `json:"memoryOn"`
	MemoryWrite bool `json:"memoryWrite"`
	MCPAssign   bool `json:"mcpAssign"`
	MCPApprove  bool `json:"mcpApprove"`
	DraftPR     bool `json:"draftPR"`
	PRLink      bool `json:"prLink"`
	CheckNotify bool `json:"checkNotify"`
	CheckFix    bool `json:"checkFix"`
	ShareWho    int  `json:"shareWho"`
	ShareTerm   bool `json:"shareTerm"`
	ShareRedact bool `json:"shareRedact"`
	ShareTTL    int  `json:"shareTTL"`
	Worktrees   bool `json:"worktrees"`
	OutsideRoot int  `json:"outsideRoot"`

	// Prompts are the quick commands typed after "/".
	Prompts []QuickPrompt `json:"prompts"`
	// Tasks are the scheduled tasks (stored only: no scheduler runs them).
	Tasks []ScheduledTask `json:"tasks"`
}

// QuickPrompt is one "/" command: its name and the text it puts in the
// composer.
type QuickPrompt struct {
	Name string `json:"name"`
	Text string `json:"text"`
	Hint string `json:"hint"`
}

// ScheduledTask is a prompt to run with an agent on a schedule.
type ScheduledTask struct {
	Name     string `json:"name"`
	AgentID  string `json:"agentId"`
	Project  string `json:"project"`
	Prompt   string `json:"prompt"`
	Schedule string `json:"schedule"`
	Branch   string `json:"branch"`
	Mode     int    `json:"mode"`
	Enabled  bool   `json:"enabled"`
}

// TaskDraft is the new-task popover's form.
type TaskDraft struct {
	Name     string
	Prompt   string
	Schedule int // index into TaskSchedules
	Time     string
	Branch   string
	AgentID  string
	Mode     int
}

// TaskSchedules are the repeat choices of a new task, as message keys.
var TaskSchedules = []string{"schedDaily", "schedWeekdays", "schedWeekly", "schedHourly"}

func defaultPrefs() Prefs {
	// The built-in quick commands are written in the language omo starts in;
	// they are the user's to edit from there.
	loc := i18n.Locale()
	return Prefs{
		Theme:         "system",
		FontSize:      1,
		CollapseReads: true,
		SessionMode:   1,
		NotifyAsk:     true,
		NotifyEnd:     true,
		AutoUpdate:    true,
		IdleClose:     1,
		MemoryOn:      true,
		MCPAssign:     true,
		MCPApprove:    true,
		DraftPR:       true,
		CheckNotify:   true,
		ShareRedact:   true,
		ShareTTL:      1,
		Prompts: []QuickPrompt{
			{Name: "/review", Hint: "promptReviewHint", Text: i18n.T(loc, "promptReviewText")},
			{Name: "/fix-ci", Hint: "promptFixCIHint", Text: i18n.T(loc, "promptFixCIText")},
			{Name: "/changeset", Hint: "promptChangesetHint", Text: i18n.T(loc, "promptChangesetText")},
		},
	}
}

// SessionInfo is one row of the sidebar's session list and the recent
// sessions of the new-session screen.
type SessionInfo struct {
	AgentID   string
	AgentName string
	Title     string
	UpdatedAt time.Time
	// State is running, waiting (an approval is pending), failed or done.
	State  string
	Active bool
}

// AgentProcess is one row of "本机 Agent": a configured ACP agent and what its
// local process is doing.
type AgentProcess struct {
	ID    string
	Name  string
	State string // running, idle, starting, off, failed
}

// SearchHit is one result of the search palette.
type SearchHit struct {
	Kind    string // session, file, command
	Title   string
	Meta    string
	AgentID string
	Path    string
	Command string
}

// Prefs returns the preferences for the settings widgets to bind to.
func (a *App) Prefs() *Prefs { return &a.prefs }

// SavePrefs writes the preferences to the store. The settings window calls it
// when it closes; Shutdown calls it too.
func (a *App) SavePrefs() {
	if a.store == nil {
		return
	}
	blob, err := json.Marshal(a.prefs)
	if err != nil {
		return
	}
	if err := a.store.SaveUI(a.ctx, prefsUIKey, blob); err != nil {
		a.appendDiagnostic(err.Error())
	}
}

func (a *App) loadPrefs() {
	if a.store == nil {
		return
	}
	blob, ok, err := a.store.UI(a.ctx, prefsUIKey)
	if err != nil || !ok {
		return
	}
	p := defaultPrefs()
	if err := json.Unmarshal(blob, &p); err == nil {
		a.prefs = p
	}
}

// UserName is the name the sidebar's footer shows: the account's full name
// when the system has one, else its login.
func (a *App) UserName() string {
	if a.userName != "" {
		return a.userName
	}
	if u, err := user.Current(); err == nil {
		a.userName = strings.TrimSpace(u.Name)
		if a.userName == "" {
			a.userName = u.Username
		}
		if i := strings.LastIndexAny(a.userName, `\/`); i >= 0 {
			a.userName = a.userName[i+1:]
		}
	}
	if a.userName == "" {
		a.userName = "omo"
	}
	return a.userName
}

// SetUserName fixes the footer's name; screenshots use it so every machine
// draws the same window.
func (a *App) SetUserName(name string) { a.userName = name }

// Projects are the recently opened workspaces, newest first, the open one
// included.
func (a *App) Projects() []persistence.Workspace { return a.projects }

func (a *App) refreshProjects() {
	if a.store == nil {
		return
	}
	recent, err := a.store.RecentWorkspaces(a.ctx, 8)
	if err != nil {
		a.appendDiagnostic(err.Error())
		return
	}
	a.projects = recent
}

// SessionCount is how many sessions a project has, as the store knows.
func (a *App) SessionCount(path string) int {
	if a.store == nil {
		return 0
	}
	sessions, err := a.store.Sessions(a.ctx, path)
	if err != nil {
		return 0
	}
	return len(sessions)
}

// Sessions lists the open workspace's sessions, one per agent that worked
// here, newest first, with the live state of the active one.
func (a *App) Sessions() []SessionInfo {
	out := make([]SessionInfo, 0, len(a.sessionRows)+1)
	seenActive := false
	for _, s := range a.sessionRows {
		info := s
		if info.AgentID == a.activeAgentID && (a.Layout.Screen == ScreenSession || a.agentState != agent.StateDisconnected) {
			info.Active = a.Layout.Screen == ScreenSession
			info.State = a.sessionState()
			if a.title != "" {
				info.Title = a.title
			}
			seenActive = true
		}
		out = append(out, info)
	}
	if !seenActive && a.title != "" {
		out = append([]SessionInfo{{
			AgentID: a.activeAgentID, AgentName: a.agentName(a.activeAgentID), Title: a.title,
			UpdatedAt: time.Now(), State: a.sessionState(), Active: a.Layout.Screen == ScreenSession,
		}}, out...)
	}
	return out
}

func (a *App) sessionState() string {
	switch {
	case a.permission != nil:
		return "waiting"
	case a.agentState == agent.StateError:
		return "failed"
	case a.agentState == agent.StatePrompting || a.agentState == agent.StateStarting || a.agentState == agent.StateCancelling:
		return "running"
	}
	return "done"
}

func (a *App) refreshSessions() {
	a.sessionRows = nil
	if a.store == nil || a.WorkspacePath() == "" {
		return
	}
	sessions, err := a.store.Sessions(a.ctx, a.WorkspacePath())
	if err != nil {
		a.appendDiagnostic(err.Error())
		return
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].UpdatedAt.After(sessions[j].UpdatedAt) })
	for _, s := range sessions {
		title := ""
		if blob, ok, err := a.store.UI(a.ctx, titleUIKey+s.ID); err == nil && ok {
			title = string(blob)
		}
		a.sessionRows = append(a.sessionRows, SessionInfo{
			AgentID: s.AgentID, AgentName: a.agentName(s.AgentID), Title: title,
			UpdatedAt: s.UpdatedAt, State: "done",
		})
	}
}

// SessionTitle is the title of the open session: the first line of its first
// prompt.
func (a *App) SessionTitle() string { return a.title }

// setTitle names the session from its first prompt and stores the name.
func (a *App) setTitle(prompt string) {
	if a.title != "" {
		return
	}
	line, _, _ := strings.Cut(strings.TrimSpace(prompt), "\n")
	r := []rune(strings.TrimSpace(line))
	if len(r) > maxTitleRune {
		r = append(r[:maxTitleRune], '…')
	}
	a.title = string(r)
	if a.store != nil && a.WorkspacePath() != "" {
		_ = a.store.SaveUI(a.ctx, titleUIKey+a.WorkspacePath()+"|"+a.activeAgentID, []byte(a.title))
	}
}

func (a *App) agentName(id string) string {
	if def, ok := a.agentDefinition(id); ok {
		return def.Name
	}
	return id
}

// AgentProcesses lists the configured agents with what their process does.
// omo runs one agent process at a time (docs/roadmap.md), so every agent but
// the active one is off, or failed if it was the last to fail.
func (a *App) AgentProcesses() []AgentProcess {
	defs := a.AgentDefinitions()
	out := make([]AgentProcess, 0, len(defs))
	for _, d := range defs {
		p := AgentProcess{ID: d.ID, Name: d.Name, State: "off"}
		if d.ID == a.activeAgentID {
			switch a.agentState {
			case agent.StateReady:
				p.State = "idle"
			case agent.StatePrompting, agent.StateCancelling:
				p.State = "running"
			case agent.StateStarting:
				p.State = "starting"
			case agent.StateError:
				p.State = "failed"
			}
		} else if a.failedAgents[d.ID] {
			p.State = "failed"
		}
		out = append(out, p)
	}
	return out
}

// ActiveAgentName is the name of the selected agent, or "".
func (a *App) ActiveAgentName() string {
	if a.activeAgentID == "" {
		return ""
	}
	return a.agentName(a.activeAgentID)
}

// Plan is the agent's latest ACP plan.
func (a *App) Plan() []agent.PlanEntry { return a.plan }

// TurnInfo is how the last finished turn went: for the line under the answer.
type TurnInfo struct {
	Duration   time.Duration
	ToolCalls  int
	StopReason string
	Done       bool
}

// LastTurn reports the last finished turn, if any.
func (a *App) LastTurn() TurnInfo { return a.lastTurn }

// TurnStarted is when the running turn began, zero when none runs.
func (a *App) TurnStarted() time.Time { return a.turnStart }

// ToolCalls counts the tool calls of this session, and how many are waiting.
func (a *App) ToolCalls() (total, waiting int) {
	for _, it := range a.chatItems {
		if it.Kind == agent.EventTool {
			total++
		}
	}
	if a.permission != nil {
		waiting = 1 + len(a.permissionQueue)
	}
	return total, waiting
}

// AgentOutput is the tail of the agent process's standard error, as lines.
func (a *App) AgentOutput(max int) []string {
	if a.agents == nil {
		return nil
	}
	out := strings.TrimRight(a.agents.Output(), "\n")
	if out == "" {
		return nil
	}
	lines := strings.Split(out, "\n")
	if len(lines) > max {
		lines = lines[len(lines)-max:]
	}
	return lines
}

// LastPrompt is the last message the user sent in this session.
func (a *App) LastPrompt() string {
	for i := len(a.chatItems) - 1; i >= 0; i-- {
		if a.chatItems[i].User {
			return a.chatItems[i].Text
		}
	}
	return ""
}

// AgentExecutable is the program the active agent runs, for the trust dialog
// and the error card.
func (a *App) AgentExecutable(id string) string {
	if def, ok := a.agentDefinition(id); ok {
		return def.Executable
	}
	return ""
}

// ChangeTotals sums the lines the agent added and deleted.
func (a *App) ChangeTotals() (added, deleted int) {
	for _, ch := range a.agentChanges {
		added += ch.Added
		deleted += ch.Deleted
	}
	return added, deleted
}

// Status is the change's letter: A for a file the agent created, D for one it
// deleted, M otherwise.
func (c AgentChange) Status() string {
	switch {
	case c.Review.NewFile:
		return "A"
	case !c.Review.Stamp.Exists:
		return "D"
	}
	return "M"
}

// GitStatus is the git status letter of a workspace path, or "".
func (a *App) GitStatus(rel string) string {
	for _, ch := range a.changes {
		if ch.Path == rel {
			if ch.Status == "?" {
				return "A"
			}
			return ch.Status
		}
	}
	return ""
}

// Search finds sessions, files and commands whose names hold the query, at
// most limit of each kind. Files come from a bounded walk of the workspace.
func (a *App) Search(query string, limit int) []SearchHit {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return nil
	}
	var hits []SearchHit
	n := 0
	for _, s := range a.Sessions() {
		if n == limit {
			break
		}
		if strings.Contains(strings.ToLower(s.Title), q) {
			hits = append(hits, SearchHit{Kind: "session", Title: s.Title, Meta: s.AgentName, AgentID: s.AgentID})
			n++
		}
	}
	n = 0
	for _, rel := range a.fileIndex() {
		if n == limit {
			break
		}
		if strings.Contains(strings.ToLower(rel), q) {
			hits = append(hits, SearchHit{Kind: "file", Title: rel, Meta: a.WorkspaceName(), Path: rel})
			n++
		}
	}
	n = 0
	for _, cmd := range a.cmds.List() {
		if n == limit {
			break
		}
		if strings.Contains(strings.ToLower(string(cmd.ID)), q) || strings.Contains(strings.ToLower(cmd.Title), q) {
			hits = append(hits, SearchHit{Kind: "command", Title: cmd.Title, Command: string(cmd.ID)})
			n++
		}
	}
	return hits
}

const maxIndexedFiles = 5000

// skipDirs are folders search does not walk: version control and dependencies.
var skipDirs = map[string]bool{
	".git": true, ".hg": true, ".svn": true, "node_modules": true, "vendor": true,
	".next": true, ".cache": true, "dist": true, "build": true, "target": true,
}

// fileIndex walks the workspace once per open, breadth first, skipping
// dot-directories and dependency folders, up to maxIndexedFiles paths.
func (a *App) fileIndex() []string {
	if a.ws == nil {
		return nil
	}
	if a.files != nil {
		return a.files
	}
	a.files = []string{}
	queue := []string{""}
	for len(queue) > 0 && len(a.files) < maxIndexedFiles {
		dir := queue[0]
		queue = queue[1:]
		entries, err := a.ws.List(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			rel := e.Name
			if dir != "" {
				rel = path.Join(dir, e.Name)
			}
			if e.IsDir {
				if skipDirs[e.Name] {
					continue
				}
				queue = append(queue, rel)
				continue
			}
			a.files = append(a.files, rel)
		}
	}
	return a.files
}

// TaskDraft is the new-task form.
func (a *App) TaskDraft() *TaskDraft { return &a.taskDraft }

func (a *App) addTask() {
	d := a.taskDraft
	name := strings.TrimSpace(d.Name)
	prompt := strings.TrimSpace(d.Prompt)
	if name == "" || prompt == "" {
		a.setNotice(Notice{Key: "schedNeedNameAndPrompt"})
		return
	}
	agentID := d.AgentID
	if agentID == "" {
		agentID = a.activeAgentID
	}
	when := strings.TrimSpace(d.Time)
	if when == "" {
		when = "09:00"
	}
	key := TaskSchedules[0]
	if d.Schedule >= 0 && d.Schedule < len(TaskSchedules) {
		key = TaskSchedules[d.Schedule]
	}
	a.prefs.Tasks = append(a.prefs.Tasks, ScheduledTask{
		Name: name, AgentID: agentID, Project: a.WorkspaceName(), Prompt: prompt,
		Schedule: key + " " + when, Branch: strings.TrimSpace(d.Branch), Mode: d.Mode, Enabled: true,
	})
	a.Layout.TaskSel = len(a.prefs.Tasks) - 1
	a.Layout.NewTaskOpen = false
	a.taskDraft = TaskDraft{}
	a.SavePrefs()
}

// DataDir is where omo keeps its database, for Settings → General and About.
func DataDir() string {
	dir, err := dataDir()
	if err != nil {
		return ""
	}
	if home, err := os.UserHomeDir(); err == nil && strings.HasPrefix(dir, home) {
		return "~" + dir[len(home):]
	}
	return dir
}

// dispatchConsole applies the console's intents; Dispatch calls it for the
// ones it does not know.
func (a *App) dispatchConsole(in Intent) {
	switch v := in.(type) {
	case NewSession:
		a.newSession()
	case ShowScreen:
		a.Layout.Screen = v.Name
		a.Layout.Settings = false
	case OpenSettings:
		a.Layout.Settings = true
		if v.Page != "" {
			a.Layout.SettingsPage = v.Page
		}
		a.Layout.SearchOpen, a.Layout.PickerOpen = false, false
	case CloseSettings:
		a.Layout.Settings = false
		a.SavePrefs()
	case ToggleSidePanel:
		if a.Layout.SidePanel == v.Name {
			a.Layout.SidePanel = ""
		} else {
			a.Layout.SidePanel = v.Name
			if v.Name == PanelChanges {
				a.refreshReview()
			}
		}
	case ToggleInspector:
		if a.Layout.SidePanel != "" {
			a.Layout.SidePanel = ""
			a.Layout.Inspector = true
		} else {
			a.Layout.Inspector = !a.Layout.Inspector
		}
	case OpenSearch:
		a.Layout.SearchOpen = true
		a.Layout.PickerOpen = false
	case CloseSearch:
		a.Layout.SearchOpen = false
		a.Layout.SearchQuery = ""
	case OpenPicker:
		a.Layout.PickerOpen = true
		a.Layout.SearchOpen = false
	case ClosePicker:
		a.Layout.PickerOpen = false
		a.Layout.PickerQuery = ""
	case CycleTheme:
		switch a.prefs.Theme {
		case "dark":
			a.prefs.Theme = "light"
		case "light":
			a.prefs.Theme = "system"
		default:
			a.prefs.Theme = "dark"
		}
		a.SavePrefs()
	case SetTheme:
		a.prefs.Theme = v.Mode
		a.SavePrefs()
	case ContinueWith:
		a.continueWith(v.ID)
	case ReLogin:
		if exe := a.AgentExecutable(a.activeAgentID); exe != "" {
			a.startTerminal([]string{exe})
		}
	case CommitChanges:
		a.commitChanges()
	case InsertPrompt:
		if a.agentInput != "" && !strings.HasSuffix(a.agentInput, " ") {
			a.agentInput += " "
		}
		a.agentInput += v.Text
	case OpenSearchHit:
		a.openSearchHit(v.Hit)
	case OpenProject:
		if v.Path != a.WorkspacePath() {
			a.openWorkspace(v.Path)
		}
		a.Layout.Screen = ScreenHome
		a.Layout.Settings = false
	case NewTask:
		a.Layout.NewTaskOpen = true
		a.taskDraft = TaskDraft{AgentID: a.activeAgentID, Time: "09:00", Schedule: 1}
	case AddTask:
		a.addTask()
	case ToggleTask:
		if v.Index >= 0 && v.Index < len(a.prefs.Tasks) {
			a.prefs.Tasks[v.Index].Enabled = !a.prefs.Tasks[v.Index].Enabled
			a.SavePrefs()
		}
	case DeleteTask:
		if v.Index >= 0 && v.Index < len(a.prefs.Tasks) {
			a.prefs.Tasks = append(a.prefs.Tasks[:v.Index], a.prefs.Tasks[v.Index+1:]...)
			if a.Layout.TaskSel >= len(a.prefs.Tasks) {
				a.Layout.TaskSel = len(a.prefs.Tasks) - 1
			}
			a.SavePrefs()
		}
	case AllowForSession:
		a.allowForSession()
	case AddPrompt:
		a.prefs.Prompts = append(a.prefs.Prompts, QuickPrompt{Name: "/new"})
		a.Layout.PromptSel = len(a.prefs.Prompts) - 1
	case DeletePrompt:
		if v.Index >= 0 && v.Index < len(a.prefs.Prompts) {
			a.prefs.Prompts = append(a.prefs.Prompts[:v.Index], a.prefs.Prompts[v.Index+1:]...)
			if a.Layout.PromptSel >= len(a.prefs.Prompts) {
				a.Layout.PromptSel = max(0, len(a.prefs.Prompts)-1)
			}
			a.SavePrefs()
		}
	}
}

// newSession clears the transcript and shows the new-session screen. A running
// turn is cancelled first: a session that is not shown must not keep writing.
func (a *App) newSession() {
	if a.agentState == agent.StatePrompting || a.agentState == agent.StateStarting {
		a.cancelTurn()
	}
	a.closeAgent()
	a.chatItems = nil
	a.chatSeal = false
	a.title = ""
	a.plan = nil
	a.lastTurn = TurnInfo{}
	a.Layout.Screen = ScreenHome
	a.Layout.SidePanel = ""
	a.Layout.Settings = false
	// The next prompt asks for a new ACP session rather than the stored one.
	if a.sessions != nil {
		delete(a.sessions, a.activeAgentID)
	}
}

// continueWith hands the session's last prompt to another agent.
func (a *App) continueWith(id string) {
	prompt := a.LastPrompt()
	if _, ok := a.agentDefinition(id); !ok {
		return
	}
	a.closeAgent()
	a.activeAgentID = id
	a.Layout.PickerOpen = false
	if prompt == "" {
		return
	}
	a.agentInput = prompt
	a.title = ""
	a.sendPrompt()
}

func (a *App) commitChanges() {
	if a.repo == nil {
		a.setNotice(Notice{Key: "statusNoRepo"})
		return
	}
	msg := strings.TrimSpace(a.Layout.CommitMsg)
	if msg == "" {
		a.setNotice(Notice{Key: "commitNeedMessage"})
		return
	}
	if err := a.repo.Commit(a.ctx, msg); err != nil {
		a.setNotice(Notice{Key: "noticeActionFailed", Args: map[string]any{"err": err.Error()}})
		return
	}
	a.Layout.CommitMsg = ""
	a.acceptReview()
	a.refreshGit(true)
	a.setNotice(Notice{Key: "commitDone"})
}

func (a *App) openSearchHit(h SearchHit) {
	a.Layout.SearchOpen = false
	a.Layout.SearchQuery = ""
	switch h.Kind {
	case "file":
		a.openFile(h.Path)
		a.Layout.Screen = ScreenSession
		a.Layout.SidePanel = PanelFiles
	case "session":
		if h.AgentID != a.activeAgentID {
			a.Dispatch(SelectAgent{ID: h.AgentID})
		}
		a.Layout.Screen = ScreenSession
		if a.title == "" {
			a.title = h.Title
		}
	case "command":
		a.Run(commands.ID(h.Command))
	}
}

func (NewSession) isIntent()      {}
func (ShowScreen) isIntent()      {}
func (OpenSettings) isIntent()    {}
func (CloseSettings) isIntent()   {}
func (ToggleSidePanel) isIntent() {}
func (ToggleInspector) isIntent() {}
func (OpenSearch) isIntent()      {}
func (CloseSearch) isIntent()     {}
func (OpenPicker) isIntent()      {}
func (ClosePicker) isIntent()     {}
func (CycleTheme) isIntent()      {}
func (SetTheme) isIntent()        {}
func (ContinueWith) isIntent()    {}
func (ReLogin) isIntent()         {}
func (CommitChanges) isIntent()   {}
func (InsertPrompt) isIntent()    {}
func (OpenSearchHit) isIntent()   {}
func (OpenProject) isIntent()     {}
func (AddTask) isIntent()         {}
func (NewTask) isIntent()         {}
func (ToggleTask) isIntent()      {}
func (DeleteTask) isIntent()      {}
func (AddPrompt) isIntent()       {}
func (DeletePrompt) isIntent()    {}

func (AllowForSession) isIntent() {}

// allowOnceOption is the request's allow_once option, if it has one.
func allowOnceOption(p AgentPermission) string {
	for _, o := range p.Options {
		if o.Kind == "allow_once" {
			return o.ID
		}
	}
	return ""
}

// allowForSession allows the pending request once and remembers its kind, so
// the rest of this session's requests of that kind are allowed without asking.
// The grant lives in memory and ends with the session; the agent only ever
// sees allow_once.
func (a *App) allowForSession() {
	if a.permission == nil {
		return
	}
	id := allowOnceOption(*a.permission)
	if id == "" {
		return
	}
	if a.sessionAllow == nil {
		a.sessionAllow = make(map[string]bool)
	}
	a.sessionAllow[permissionScope(*a.permission)] = true
	a.resolvePermission(id)
}

// permissionScope is what a session grant covers: the tool kind, or the title
// when the agent reports no kind.
func permissionScope(p AgentPermission) string {
	if p.Kind != "" {
		return "kind:" + p.Kind
	}
	return "title:" + p.Title
}

// autoAllow answers a request the session already allowed, and reports
// whether it did.
func (a *App) autoAllow(p AgentPermission) bool {
	if !a.sessionAllow[permissionScope(p)] || a.agents == nil {
		return false
	}
	id := allowOnceOption(p)
	if id == "" || !a.agents.Resolve(p.RequestID, id) {
		return false
	}
	for i := range a.chatItems {
		if a.chatItems[i].ToolCallID != "" && a.chatItems[i].ToolCallID == p.ToolCallID {
			a.chatItems[i].Allowed = true
		}
	}
	return true
}

// Replay applies a session as if an agent had sent it: the user's prompt, the
// agent's events, with the turn started worked ago. Screenshots and view tests
// use it to draw a session without starting a process; the app itself never
// calls it.
func (a *App) Replay(prompt string, worked time.Duration, events ...agent.Event) {
	if prompt != "" {
		a.setTitle(prompt)
		a.appendChat(ChatItem{Kind: agent.EventText, Text: prompt, User: true})
		a.turnStart = time.Now().Add(-worked)
		a.turnTools = 0
	}
	a.Layout.Screen = ScreenSession
	for _, ev := range events {
		a.onAgentEvent(ev)
	}
}
