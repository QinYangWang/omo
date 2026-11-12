// Package host implements the capabilities the JavaScript agent may use.
//
// Everything here is workspace-scoped: a path is resolved against the
// workspace root, symbolic links are resolved, and both the lexical path
// and the resolved path must stay inside the root. Nothing in this package
// can reach outside the directory the user picked.
package host

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	maxReadBytes    = 256 << 10
	maxSearchFiles  = 4000
	maxSearchResult = 100
)

type Workspace struct {
	root     string
	rootReal string
}

func Open(dir string) (*Workspace, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", abs)
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, err
	}
	return &Workspace{root: abs, rootReal: real}, nil
}

func (w *Workspace) Root() string { return w.rootReal }

func within(root, target string) bool {
	if strings.EqualFold(root, target) {
		return true
	}
	prefix := root
	if !strings.HasSuffix(prefix, string(os.PathSeparator)) {
		prefix += string(os.PathSeparator)
	}
	return strings.HasPrefix(strings.ToLower(target), strings.ToLower(prefix))
}

// Resolve turns a workspace-relative path into an absolute path that is
// guaranteed (after following symbolic links) to stay inside the workspace.
func (w *Workspace) Resolve(p string) (string, error) {
	if strings.TrimSpace(p) == "" {
		p = "."
	}
	var abs string
	if filepath.IsAbs(p) {
		abs = filepath.Clean(p)
	} else {
		abs = filepath.Join(w.rootReal, p)
	}
	if !within(w.rootReal, abs) {
		return "", fmt.Errorf("path %q escapes the workspace", p)
	}
	real, err := resolveExisting(abs)
	if err != nil {
		return "", err
	}
	if !within(w.rootReal, real) {
		return "", fmt.Errorf("path %q escapes the workspace through a symbolic link", p)
	}
	return real, nil
}

// resolveExisting resolves every symbolic link in the longest existing
// prefix of path, then appends the remaining, not-yet-existing segments.
func resolveExisting(path string) (string, error) {
	remaining := []string{}
	current := path
	for {
		if _, err := os.Lstat(current); err == nil {
			break
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", fmt.Errorf("cannot resolve %q", path)
		}
		remaining = append([]string{filepath.Base(current)}, remaining...)
		current = parent
	}
	real, err := filepath.EvalSymlinks(current)
	if err != nil {
		return "", err
	}
	return filepath.Join(append([]string{real}, remaining...)...), nil
}

type ListEntry struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
	Size int64  `json:"size"`
}

type ListResult struct {
	Path    string      `json:"path"`
	Entries []ListEntry `json:"entries"`
	Count   int         `json:"count"`
	Text    string      `json:"text"`
}

func (w *Workspace) List(rel string) (*ListResult, error) {
	abs, err := w.Resolve(rel)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, err
	}
	out := &ListResult{Path: rel}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		kind := "file"
		if entry.IsDir() {
			kind = "dir"
		} else if info.Mode()&os.ModeSymlink != 0 {
			kind = "symlink"
		}
		out.Entries = append(out.Entries, ListEntry{Name: entry.Name(), Kind: kind, Size: info.Size()})
	}
	sort.Slice(out.Entries, func(i, j int) bool {
		if out.Entries[i].Kind != out.Entries[j].Kind {
			return out.Entries[i].Kind == "dir"
		}
		return strings.ToLower(out.Entries[i].Name) < strings.ToLower(out.Entries[j].Name)
	})
	out.Count = len(out.Entries)
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n", rel)
	for _, entry := range out.Entries {
		suffix := ""
		if entry.Kind == "dir" {
			suffix = "/"
		} else {
			suffix = fmt.Sprintf("  (%d bytes)", entry.Size)
		}
		fmt.Fprintf(&b, "  %s%s%s\n", entry.Name, suffix, "")
	}
	if out.Count == 0 {
		b.WriteString("  (empty)\n")
	}
	out.Text = b.String()
	return out, nil
}

type ReadResult struct {
	Path      string `json:"path"`
	Text      string `json:"text"`
	Bytes     int    `json:"bytes"`
	Truncated bool   `json:"truncated"`
}

func (w *Workspace) Read(rel string, startLine, endLine int) (*ReadResult, error) {
	abs, err := w.Resolve(rel)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, fmt.Errorf("%s is a directory", rel)
	}
	if info.Size() > maxReadBytes && startLine <= 0 && endLine <= 0 {
		return nil, fmt.Errorf("%s is %d bytes; pass start_line and end_line to read a range", rel, info.Size())
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("%s is not UTF-8 text", rel)
	}
	text := string(data)
	truncated := false
	if startLine > 0 || endLine > 0 {
		lines := strings.Split(text, "\n")
		from := startLine
		if from <= 0 {
			from = 1
		}
		to := endLine
		if to <= 0 || to > len(lines) {
			to = len(lines)
		}
		if from > len(lines) {
			from = len(lines)
		}
		if to < from {
			to = from
		}
		var b strings.Builder
		for i := from; i <= to; i++ {
			fmt.Fprintf(&b, "%d\t%s\n", i, lines[i-1])
		}
		text = b.String()
		truncated = to < len(lines)
	} else if len(text) > maxReadBytes {
		text = text[:maxReadBytes]
		truncated = true
	}
	return &ReadResult{Path: rel, Text: text, Bytes: len(text), Truncated: truncated}, nil
}

type WriteResult struct {
	Path  string `json:"path"`
	Bytes int    `json:"bytes"`
}

func (w *Workspace) Write(rel string, content string) (*WriteResult, error) {
	abs, err := w.Resolve(rel)
	if err != nil {
		return nil, err
	}
	if info, err := os.Stat(abs); err == nil && info.IsDir() {
		return nil, fmt.Errorf("%s is a directory", rel)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, err
	}
	// Resolve once more: creating a directory may have crossed a link.
	abs, err = w.Resolve(rel)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		return nil, err
	}
	return &WriteResult{Path: rel, Bytes: len(content)}, nil
}

type SearchMatch struct {
	Path string `json:"path"`
	Line int    `json:"line,omitempty"`
	Text string `json:"text,omitempty"`
}

type SearchResult struct {
	Query     string        `json:"query"`
	Matches   int           `json:"matches"`
	Truncated bool          `json:"truncated"`
	Text      string        `json:"text"`
	Results   []SearchMatch `json:"results"`
}

func (w *Workspace) Search(query, rel string, maxResults int) (*SearchResult, error) {
	if strings.TrimSpace(query) == "" {
		return nil, fmt.Errorf("query is empty")
	}
	if maxResults <= 0 || maxResults > maxSearchResult {
		maxResults = 40
	}
	base, err := w.Resolve(rel)
	if err != nil {
		return nil, err
	}
	needle := strings.ToLower(query)
	out := &SearchResult{Query: query}
	scanned := 0
	var b strings.Builder
	errStop := errors.New("enough")
	_ = filepath.WalkDir(base, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if d.IsDir() {
			switch d.Name() {
			case ".git", "node_modules", ".gocache", "bin", "dist":
				if path != base {
					return filepath.SkipDir
				}
			}
			return nil
		}
		if out.Matches >= maxResults || scanned >= maxSearchFiles {
			out.Truncated = true
			return errStop
		}
		scanned++
		relPath, err := filepath.Rel(w.rootReal, path)
		if err != nil {
			return nil
		}
		relPath = filepath.ToSlash(relPath)
		nameHit := strings.Contains(strings.ToLower(d.Name()), needle)
		if nameHit {
			out.Matches++
			out.Results = append(out.Results, SearchMatch{Path: relPath})
			fmt.Fprintf(&b, "%s\n", relPath)
		}
		info, err := d.Info()
		if err != nil || info.Size() > maxReadBytes {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil || !utf8.Valid(data) {
			return nil
		}
		for i, line := range strings.Split(string(data), "\n") {
			if len(line) > 400 {
				line = line[:400]
			}
			if strings.Contains(strings.ToLower(line), needle) {
				out.Matches++
				out.Results = append(out.Results, SearchMatch{Path: relPath, Line: i + 1, Text: strings.TrimSpace(line)})
				fmt.Fprintf(&b, "%s:%d: %s\n", relPath, i+1, strings.TrimSpace(line))
				if out.Matches >= maxResults {
					out.Truncated = true
					return errStop
				}
			}
		}
		return nil
	})
	if out.Matches == 0 {
		b.WriteString("No matches.\n")
	}
	out.Text = b.String()
	return out, nil
}
