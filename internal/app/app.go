// Package app holds the IDE's application state and command routing.
//
// Threading (MyGo's contract, docs/architecture.md §6): AppState is written on
// the main thread only. View callbacks run there synchronously, so they may call
// Dispatch and Run directly. Background goroutines — the file watcher, terminal
// exit hooks — come back through post, which posts to the window main thread.
//
// The app never formats user-visible text: it stores a Notice, a message key
// with its arguments, and the views translate it with the window's locale.
package app

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/QinYangWang/omo/internal/agent"
	"github.com/QinYangWang/omo/internal/commands"
	"github.com/QinYangWang/omo/internal/diff"
	"github.com/QinYangWang/omo/internal/documents"
	"github.com/QinYangWang/omo/internal/git"
	"github.com/QinYangWang/omo/internal/persistence"
	"github.com/QinYangWang/omo/internal/workspace"
	"github.com/egoist/mygo"
)

// FileNode is one node of the Explorer tree. Children load the first time the
// node is opened, so a directory is read only when the user looks at it.
type FileNode struct {
	Name     string
	Rel      string
	IsDir    bool
	Open     bool
	Loaded   bool
	LoadErr  string
	Children []*FileNode
}

// TabKind is what a tab shows.
type TabKind int

const (
	// TabFile is an editor on a document.
	TabFile TabKind = iota + 1
	// TabDiff is a review of one file's changes.
	TabDiff
	// TabReview is the list of files an agent changed.
	TabReview
)

// Tab is one editor tab. A file tab owns its editor.State; a diff tab owns the
// DiffState and the review it came from.
type Tab struct {
	Kind     TabKind
	Rel      string
	Editor   *editorState
	Diff     *editorDiff
	Review   diff.Review
	Saveable bool
}

// Layout is state the UI widgets bind to directly: split ratios, the sidebar's
// selection, which sections are open, and the current tab and panel page.
//
// The widgets keep a *float32, *string, *bool or *int between frames, so these
// fields must live in a stable object: a field of App, never a local variable.
type Layout struct {
	// RightSel is the page of the right sidebar: files, search, git, run or
	// browser.
	RightSel     string
	PanelItemSel string
	ExplorerOpen bool
	OutlineOpen  bool
	MainRows     float32 // main area as a percentage of the window (0-100)
	ActiveTab    int
	PanelTab     int
	ActiveTerm   int
	SessionQuery string // the sessions panel's filter
	BrowserURL   string
}

// Notice is a localizable status message: a catalog key plus its arguments.
type Notice struct {
	Key  string
	Args map[string]any
}

// App owns all UI state.
type App struct {
	ctx    context.Context
	cancel context.CancelFunc
	closed atomic.Bool
	// win posts work to the main thread from background goroutines. It is nil
	// before the window exists and in tests, where post runs inline.
	win *mygo.Window

	cmds *commands.Registry

	ws      *workspace.Service
	docs    *documents.Store
	repo    *git.Repo
	changes []git.Change
	branch  string

	// baseline is what the files the agent touched held before it touched
	// them; agentChanges is what that makes of them now.
	baseline     *diff.Baseline
	agentChanges []AgentChange
	reviewWarned bool

	roots   []*FileNode
	tabs    []Tab
	terms   []*Terminal
	termSeq int

	Layout       Layout
	panelOpen    bool
	leftOpen     bool
	rightOpen    bool
	conflict     string
	conflictOpen bool

	notice      Notice
	agentNotice Notice

	agentCatalog      *agent.Catalog
	agentCatalogErr   error
	agents            agentRuntime
	agentCtx          context.Context
	agentCancel       context.CancelFunc
	agentOperation    uint64
	activeAgentID     string
	trustAgentID      string
	trustDetails      AgentTrustDetails
	agentState        agent.State
	agentCanLoad      bool
	agentNeedsRestart bool
	agentInput        string
	chatItems         []ChatItem
	chatSeal          bool
	permission        *AgentPermission
	permissionQueue   []AgentPermission
	agentDiagnostics  []string
	agentConfig       AgentConfigDraft
	agentPicker       bool

	lastGitRefresh time.Time

	// Persistence: the metadata store, the key its layout row uses, and the ACP
	// sessions the open workspace had when it was last used.
	store     *persistence.Store
	layoutKey string
	sessions  map[string]string

	// Startup benchmark; only used when bench mode is on (bench.go).
	bench      bool
	startedAt  time.Time
	firstFrame time.Duration
}

// New builds the app state and the command table. Call it once, on the main
// thread.
func New() *App {
	ctx, cancel := context.WithCancel(context.Background())
	agentCtx, agentCancel := context.WithCancel(ctx)
	catalog, catalogErr := loadAgentCatalog()
	a := &App{
		ctx:    ctx,
		cancel: cancel,
		cmds:   commands.NewRegistry(),
		Layout: Layout{
			RightSel:     "files",
			ExplorerOpen: true,
			OutlineOpen:  false,
			MainRows:     72,
			ActiveTab:    0,
			PanelTab:     0,
		},
		panelOpen:       false,
		leftOpen:        true,
		rightOpen:       true,
		notice:          Notice{Key: "noticeReady"},
		agentNotice:     Notice{Key: "agentDisconnected"},
		agentState:      agent.StateDisconnected,
		agentCatalog:    catalog,
		agentCatalogErr: catalogErr,
		agentCtx:        agentCtx,
		agentCancel:     agentCancel,
		bench:           benchEnabled(),
		startedAt:       time.Now(),
	}
	if catalogErr != nil {
		a.agentNotice = Notice{Key: "agentCatalogFailed"}
		a.notice = Notice{Key: "agentCatalogFailed", Args: map[string]any{"err": catalogErr.Error()}}
	}
	manager := agent.NewManager()
	a.agents = manager
	go func() {
		for {
			select {
			case ev := <-manager.Events():
				// Only one main-thread drain is outstanding. Further events stay
				// in the manager's bounded channel instead of an unbounded UI queue.
				done := make(chan struct{})
				if !a.post(func() {
					a.onAgentEvent(ev)
					close(done)
				}) {
					return
				}
				select {
				case <-done:
				case <-ctx.Done():
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	if a.agentCatalog != nil {
		if defs := a.agentCatalog.List(); len(defs) > 0 {
			a.activeAgentID = defs[0].ID
		}
	}
	a.registerCommands()
	return a
}

// Attach gives the app its window, which background goroutines use to reach the
// main thread. Call it right after the window is created.
func (a *App) Attach(win *mygo.Window) { a.win = win }

// post runs fn on the main thread. Background goroutines must use it before
// touching app state.
//
// Without a window there is no main thread to reach: tests run headless and the
// work is dropped rather than writing state from a background goroutine, which
// would be a data race by construction.
func (a *App) post(fn func()) bool {
	if a.closed.Load() || a.win == nil {
		return false
	}
	a.win.Update(fn)
	return true
}

// invalidate asks for one repaint. State that changed outside an input event — a
// menu command, a watcher event, a diff applied — is invisible until a frame is
// built, and nothing else would ask for one.
func (a *App) invalidate() {
	if a.win != nil {
		a.win.Invalidate()
	}
}

// Ctx is canceled when the app shuts down.
func (a *App) Ctx() context.Context { return a.ctx }

// Commands exposes the command table to the views.
func (a *App) Commands() *commands.Registry { return a.cmds }

// WorkspaceName is the open workspace's base name, or "" when none is open.
func (a *App) WorkspaceName() string {
	if a.ws == nil {
		return ""
	}
	return a.ws.Name()
}

// WorkspacePath is the open workspace's absolute path.
func (a *App) WorkspacePath() string {
	if a.ws == nil {
		return ""
	}
	return a.ws.Path()
}

// Files returns the Explorer roots.
func (a *App) Files() []*FileNode { return a.roots }

// Changes returns the paths that differ from HEAD, as of the last refresh.
func (a *App) Changes() []git.Change { return a.changes }

// Branch is the current branch name, or "" without a repository.
func (a *App) Branch() string { return a.branch }

// Tabs returns the open tabs.
func (a *App) Tabs() []Tab { return a.tabs }

// ActiveTab returns the current tab index, or -1 when no tab is open.
func (a *App) ActiveTab() int {
	if len(a.tabs) == 0 || a.Layout.ActiveTab < 0 || a.Layout.ActiveTab >= len(a.tabs) {
		return -1
	}
	return a.Layout.ActiveTab
}

// Dirty reports whether a file has unsaved changes.
func (a *App) Dirty(rel string) bool {
	return a.docs != nil && a.docs.Dirty(rel)
}

// Terminals returns the terminal sessions.
func (a *App) Terminals() []*Terminal { return a.terms }

// PanelOpen reports whether the bottom panel is shown.
func (a *App) PanelOpen() bool { return a.panelOpen }

// LeftOpen reports whether the sessions panel is shown.
func (a *App) LeftOpen() bool { return a.leftOpen }

// RightOpen reports whether the right sidebar is shown.
func (a *App) RightOpen() bool { return a.rightOpen }

// ConflictPath is the file whose disk change needs a decision, if any.
func (a *App) ConflictPath() string { return a.conflict }

// ConflictOpen reports whether the conflict dialog is up.
func (a *App) ConflictOpen() bool { return a.conflictOpen }

// Notice is the status bar's message.
func (a *App) Notice() Notice { return a.notice }

// AgentNotice is the agent state shown in the chat panel and the status bar.
func (a *App) AgentNotice() Notice { return a.agentNotice }

// Run executes a command on the main thread. Commands must not block; work that
// blocks starts its own goroutine and reports back through post.
func (a *App) Run(id commands.ID) {
	if a.closed.Load() {
		return
	}
	if err := a.cmds.Run(a.ctx, id); err != nil {
		a.setNotice(Notice{Key: "noticeCommandFailed", Args: map[string]any{"err": err.Error()}})
	}
	a.invalidate()
}

// Shutdown runs after the event loop stops (mygo.App.OnQuit).
func (a *App) Shutdown() {
	if a.closed.Swap(true) {
		return
	}
	// The layout is saved from the tabs, so it goes before the workspace does.
	a.closeStore()
	a.closeTerminals()
	a.closeWorkspace()
	a.cancel()
}

// setNotice replaces the status bar message.
func (a *App) setNotice(n Notice) { a.notice = n }

// TabAt returns a tab by index, or nil.
func (a *App) TabAt(i int) *Tab {
	if i < 0 || i >= len(a.tabs) {
		return nil
	}
	return &a.tabs[i]
}

// CursorLineCol is the active editor's caret, 1-based, for the status bar.
func (a *App) CursorLineCol() (line, col int, ok bool) {
	t := a.activeTab()
	if t == nil || t.Kind != TabFile || t.Editor == nil {
		return 0, 0, false
	}
	p := t.Editor.CursorPos()
	return p.Line + 1, p.Col + 1, true
}

// LineEnding is the active file's line ending, "CRLF" or "LF".
func (a *App) LineEnding() string {
	t := a.activeTab()
	if t == nil || t.Kind != TabFile || t.Editor == nil || t.Editor.Buffer == nil {
		return ""
	}
	if t.Editor.Buffer.LineEnding() == "\r\n" {
		return "CRLF"
	}
	return "LF"
}

// LanguageName is the active file's detected language, "" for plain text.
func (a *App) LanguageName() string {
	t := a.activeTab()
	if t == nil || t.Kind != TabFile || t.Editor == nil || t.Editor.Buffer == nil {
		return ""
	}
	if l := t.Editor.Buffer.Language(); l != nil {
		return l.Name
	}
	return ""
}
