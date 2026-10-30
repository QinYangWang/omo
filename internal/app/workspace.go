package app

import (
	"strings"
	"time"

	"github.com/QinYangWang/omo/internal/documents"
	"github.com/QinYangWang/omo/internal/git"
	"github.com/QinYangWang/omo/internal/workspace"
	"github.com/egoist/mygo/ui/editor"
)

// openWorkspace swaps in a new workspace. Everything that belonged to the old
// one — documents, tabs, terminals, watcher — is closed first.
func (a *App) openWorkspace(dir string) {
	if dir == "" {
		a.setNotice(Notice{Key: "noticeNoWorkspaceChosen"})
		return
	}
	ws, err := workspace.Open(dir)
	if err != nil {
		a.setNotice(Notice{Key: "noticeWorkspaceFailed", Args: map[string]any{"err": err.Error()}})
		return
	}
	a.closeWorkspace()
	a.ws = ws
	a.docs = documents.New(ws)
	// A repository above the workspace is enough: paths are mapped through its
	// prefix. Without one, reviews compare the buffer with the saved file.
	if repo, err := git.Detect(a.ctx, ws.Path()); err == nil {
		a.repo = repo
	}
	a.reloadRoot()
	a.refreshGit(true)
	a.startWatch()
	a.setNotice(Notice{Key: "noticeWorkspaceOpened", Args: map[string]any{"name": ws.Name()}})
}

// closeWorkspace tears the workspace down. It is safe to call twice.
func (a *App) closeWorkspace() {
	a.closeAgent()
	a.chatItems = nil
	a.closeTerminals()
	if a.docs != nil {
		a.docs.CloseAll()
		a.docs = nil
	}
	if a.ws != nil {
		_ = a.ws.Close()
		a.ws = nil
	}
	a.repo = nil
	a.changes = nil
	a.branch = ""
	a.roots = nil
	a.tabs = nil
	a.Layout.ActiveTab = 0
	a.panelOpen = false
	a.conflict = ""
	a.conflictOpen = false
	a.permission = nil
}

// reloadRoot reads the workspace root's entries.
func (a *App) reloadRoot() {
	if a.ws == nil {
		a.roots = nil
		return
	}
	entries, err := a.ws.List("")
	if err != nil {
		a.setNotice(Notice{Key: "noticeWorkspaceFailed", Args: map[string]any{"err": err.Error()}})
		a.roots = nil
		return
	}
	roots := make([]*FileNode, 0, len(entries))
	for _, e := range entries {
		roots = append(roots, &FileNode{Name: e.Name, Rel: e.Rel, IsDir: e.IsDir})
	}
	a.roots = roots
}

// LoadChildren reads a directory the first time the user opens it. The view
// calls it from TreeItem's children callback, which only runs while the node is
// open, so a large tree costs nothing until it is browsed.
func (a *App) LoadChildren(n *FileNode) {
	if n == nil || !n.IsDir || n.Loaded || a.ws == nil {
		return
	}
	n.Loaded = true
	entries, err := a.ws.List(n.Rel)
	if err != nil {
		n.LoadErr = err.Error()
		return
	}
	n.LoadErr = ""
	children := make([]*FileNode, 0, len(entries))
	for _, e := range entries {
		children = append(children, &FileNode{Name: e.Name, Rel: e.Rel, IsDir: e.IsDir})
	}
	n.Children = children
}

// refreshGit re-reads status and branch. The throttle keeps a busy watcher from
// spawning a git process per file event; force skips it for user actions.
func (a *App) refreshGit(force bool) {
	if a.repo == nil {
		a.changes, a.branch = nil, ""
		return
	}
	if !force && time.Since(a.lastGitRefresh) < 750*time.Millisecond {
		return
	}
	a.lastGitRefresh = time.Now()
	if changes, err := a.repo.Status(a.ctx); err == nil {
		a.changes = changes
	}
	if branch, err := a.repo.Branch(a.ctx); err == nil {
		a.branch = branch
	}
}

// startWatch forwards file events to the main thread. The events are hints: the
// handler below re-reads whatever it cares about.
func (a *App) startWatch() {
	if a.ws == nil {
		return
	}
	ch, err := a.ws.Watch(a.ctx)
	if err != nil {
		a.setNotice(Notice{Key: "noticeWatchFailed", Args: map[string]any{"err": err.Error()}})
		return
	}
	go func() {
		for paths := range ch {
			a.post(func() { a.onDiskChanged(paths) })
		}
	}()
}

// onDiskChanged reconciles the UI with what the disk says now: clean buffers
// reload, dirty buffers ask the user, and git runs again (throttled).
func (a *App) onDiskChanged(paths []string) {
	if a.ws == nil {
		return // an event from a workspace that is already closed
	}
	seenDir := make(map[string]bool, len(paths))
	for _, rel := range paths {
		if d := dirName(rel); !seenDir[d] {
			seenDir[d] = true
			a.invalidateDir(d)
		}
		// A file created or deleted changes its directory listing, not itself.
		a.invalidateDir(rel)
		if a.docs == nil {
			continue
		}
		doc, ok := a.docs.Get(rel)
		if !ok {
			continue
		}
		same, err := a.docs.CheckDisk(rel)
		if err != nil || same {
			continue
		}
		if doc.Buf.Modified() {
			// Someone else wrote the file and the buffer has unsaved text:
			// never choose for the user.
			a.conflict = rel
			a.conflictOpen = true
			continue
		}
		a.reloadPreservingCaret(rel)
	}
	a.refreshGit(false)
}

// invalidateDir drops a directory's cached listing so it is read again the next
// time it is open on screen.
func (a *App) invalidateDir(rel string) {
	a.invalidateIn(a.roots, rel)
}

func (a *App) invalidateIn(nodes []*FileNode, rel string) bool {
	for _, n := range nodes {
		if n.Rel == rel {
			n.Loaded = false
			n.Children = nil
			n.LoadErr = ""
			return true
		}
		if n.IsDir && len(n.Children) > 0 && strings.HasPrefix(rel, n.Rel+"/") {
			if a.invalidateIn(n.Children, rel) {
				return true
			}
		}
	}
	return false
}

// tabOf finds the file tab showing rel, or -1.
func (a *App) tabOf(rel string) int {
	for i := range a.tabs {
		if a.tabs[i].Kind == TabFile && a.tabs[i].Rel == rel {
			return i
		}
	}
	return -1
}

// reloadPreservingCaret re-reads a file and puts the caret back where it was.
func (a *App) reloadPreservingCaret(rel string) {
	if a.docs == nil {
		return
	}
	i := a.tabOf(rel)
	caret := -1
	if i >= 0 && a.tabs[i].Editor != nil {
		caret = a.tabs[i].Editor.Cursor()
	}
	if _, err := a.docs.Reload(rel); err != nil {
		return
	}
	if i >= 0 && caret >= 0 {
		a.setCaret(a.tabs[i].Editor, caret)
	}
}

// setCaret moves the caret to off, clamped to the current text.
func (a *App) setCaret(st *editorState, off int) {
	if st == nil || st.Buffer == nil {
		return
	}
	if n := st.Buffer.Len(); off > n {
		off = n
	}
	if off < 0 {
		off = 0
	}
	st.SetSelections(editor.Selection{Anchor: off, Head: off})
}

// syncEditorBeforeReload keeps the caret across a reload the app already did.
func (a *App) syncEditorBeforeReload(rel string) {
	if i := a.tabOf(rel); i >= 0 && a.tabs[i].Editor != nil {
		a.setCaret(a.tabs[i].Editor, a.tabs[i].Editor.Cursor())
	}
}
