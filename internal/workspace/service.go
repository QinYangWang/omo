// Package workspace owns the filesystem boundary of one open directory.
//
// Every path a caller passes is workspace-relative with forward slashes, and all
// IO goes through os.Root: a path can never leave the root, and a symlink
// pointing outside it is refused by the standard library (docs/security.md §2).
//
// File events are hints, not operations (docs/architecture.md §4.1): a caller
// that sees a path must re-read it and compare stamps.
package workspace

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

const (
	// MaxFileBytes caps one read or write. A 2 GB log is not something to load
	// into the editor's memory (docs/security.md §2.2).
	MaxFileBytes = 8 << 20
	// maxWatchEntries bounds what the backend watcher enrolls per workspace.
	maxWatchEntries = 20000
)

var (
	ErrNoWorkspace = errors.New("workspace: no workspace open")
	ErrOutside     = errors.New("workspace: path outside the workspace")
	ErrNotRegular  = errors.New("workspace: not a regular file")
	ErrTooLarge    = errors.New("workspace: file too large")
	ErrConflict    = errors.New("workspace: file changed on disk")
)

// Entry is one directory listing item.
type Entry struct {
	Rel   string // workspace-relative, slash separated
	Name  string
	IsDir bool
	Size  int64
	Mod   time.Time
}

// FileStamp identifies a version of a file's content.
//
// Exists distinguishes "empty file" from "no file". Hash is only set by Read and
// Verify: Stat is cheap and leaves it zero.
type FileStamp struct {
	Exists bool
	Size   int64
	Mod    int64 // UnixNano, a fast path only: filesystem timestamps are coarse
	Hash   [32]byte
}

// Equal reports whether two stamps describe the same content.
func (s FileStamp) Equal(o FileStamp) bool {
	return s.Exists == o.Exists && s.Size == o.Size && s.Hash == o.Hash
}

// Service is one open workspace directory.
type Service struct {
	path  string
	name  string
	root  *os.Root
	watch *mygo.FileWatcher
}

// Open opens dir as a workspace. The path is made absolute and must be a
// directory.
func Open(dir string) (*Service, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("workspace: %s is not a directory", abs)
	}
	root, err := os.OpenRoot(abs)
	if err != nil {
		return nil, err
	}
	return &Service{path: abs, name: filepath.Base(abs), root: root}, nil
}

// Path is the absolute workspace root.
func (s *Service) Path() string { return s.path }

// Name is the root's base name, shown in the UI.
func (s *Service) Name() string { return s.name }

// Close stops the watcher and releases the root.
func (s *Service) Close() error {
	if s == nil {
		return nil
	}
	if s.watch != nil {
		_ = s.watch.Close()
		s.watch = nil
	}
	if s.root != nil {
		err := s.root.Close()
		s.root = nil
		return err
	}
	return nil
}

// Canonical turns caller input into a workspace-relative slash path, refusing
// anything that could name a location outside the root: absolute paths, drive
// letters, "..", and empty names.
func (s *Service) Canonical(rel string) (string, error) {
	if s == nil || s.root == nil {
		return "", ErrNoWorkspace
	}
	r := strings.TrimSpace(strings.ReplaceAll(rel, "\\", "/"))
	if r == "" {
		return "", ErrOutside
	}
	if path.IsAbs(r) || strings.HasPrefix(r, "/") || filepath.VolumeName(r) != "" {
		return "", ErrOutside
	}
	clean := path.Clean(r)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", ErrOutside
	}
	return clean, nil
}

// List reads one directory level. Children are not walked: the Explorer loads a
// directory only when the user opens it.
func (s *Service) List(rel string) ([]Entry, error) {
	// os.Root has no notion of an empty name; "." is the root itself.
	dir := "."
	if rel != "" {
		c, err := s.Canonical(rel)
		if err != nil {
			return nil, err
		}
		dir = c
	}
	f, err := s.root.Open(dir)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil {
		return nil, err
	} else if !info.IsDir() {
		return nil, fmt.Errorf("workspace: %s is not a directory", rel)
	}
	names, err := f.Readdir(-1)
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(names))
	for _, info := range names {
		entry := Entry{
			Rel:   path.Join(dir, info.Name()),
			Name:  info.Name(),
			IsDir: info.IsDir(),
			Size:  info.Size(),
			Mod:   info.ModTime(),
		}
		// A symlink is listed but never followed here: following it is the
		// IO calls' job, and os.Root refuses one that leaves the root.
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

// Read returns a file's content and stamp. Non-regular files (devices, FIFOs,
// sockets) and files over MaxFileBytes are refused rather than blocking or
// exhausting memory.
func (s *Service) Read(rel string) ([]byte, FileStamp, error) {
	c, err := s.Canonical(rel)
	if err != nil {
		return nil, FileStamp{}, err
	}
	f, err := s.root.Open(c)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, FileStamp{}, err
		}
		return nil, FileStamp{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, FileStamp{}, err
	}
	if !info.Mode().IsRegular() {
		return nil, FileStamp{}, ErrNotRegular
	}
	if info.Size() > MaxFileBytes {
		return nil, FileStamp{}, ErrTooLarge
	}
	// One byte over the cap catches a file that grew between Stat and Read.
	data, err := io.ReadAll(io.LimitReader(f, MaxFileBytes+1))
	if err != nil {
		return nil, FileStamp{}, err
	}
	if len(data) > MaxFileBytes {
		return nil, FileStamp{}, ErrTooLarge
	}
	return data, stamp(info, data), nil
}

// Stat returns a cheap stamp without hashing the content.
func (s *Service) Stat(rel string) (FileStamp, error) {
	c, err := s.Canonical(rel)
	if err != nil {
		return FileStamp{}, err
	}
	info, err := s.root.Stat(c)
	if err != nil {
		return FileStamp{Exists: false}, err
	}
	if !info.Mode().IsRegular() {
		return FileStamp{}, ErrNotRegular
	}
	return FileStamp{Exists: true, Size: info.Size(), Mod: info.ModTime().UnixNano()}, nil
}

// Verify re-reads a file and reports whether its content still matches expect.
// It hashes instead of trusting size and modification time, whose resolution is
// too coarse to catch two writes in the same tick.
func (s *Service) Verify(rel string, expect FileStamp) (bool, error) {
	_, now, err := s.Read(rel)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return !expect.Exists, nil
		}
		return false, err
	}
	return now.Equal(expect), nil
}

// Write saves data atomically: a temporary file in the same directory, then a
// rename over the target. A crash leaves the old content, never a half file.
//
// expect is the stamp the caller last read; a mismatch returns ErrConflict so
// the caller can ask the user instead of silently overwriting someone else's
// write (docs/security.md §2.3).
func (s *Service) Write(rel string, data []byte, expect FileStamp) (FileStamp, error) {
	c, err := s.Canonical(rel)
	if err != nil {
		return FileStamp{}, err
	}
	if len(data) > MaxFileBytes {
		return FileStamp{}, ErrTooLarge
	}
	if expect.Exists {
		ok, err := s.Verify(c, expect)
		if err != nil {
			return FileStamp{}, err
		}
		if !ok {
			return FileStamp{}, ErrConflict
		}
	}
	dir := path.Dir(c)
	tmp := path.Join(dir, ".omo-"+tmpSuffix())
	f, err := s.root.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return FileStamp{}, err
	}
	_, werr := f.Write(data)
	serr := f.Sync()
	cerr := f.Close()
	if werr != nil || serr != nil || cerr != nil {
		_ = s.root.Remove(tmp)
		return FileStamp{}, errors.Join(werr, serr, cerr)
	}
	if err := s.root.Rename(tmp, c); err != nil {
		_ = s.root.Remove(tmp)
		return FileStamp{}, err
	}
	return s.Stat(c)
}

// Create makes a new empty file, failing if it exists.
func (s *Service) Create(rel string) error {
	c, err := s.Canonical(rel)
	if err != nil {
		return err
	}
	f, err := s.root.OpenFile(c, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	return f.Close()
}

// Watch echoes the paths under the root that the system says changed.
//
// The returned slice is a hint: it may repeat, arrive late, or name a directory
// whose contents changed. Callers re-read the files they care about.
func (s *Service) Watch(ctx context.Context) (<-chan []string, error) {
	w, err := mygo.WatchFiles(ctx, s.path, mygo.FileWatchOptions{
		Recursive:  true,
		Ignore:     isIgnored,
		MaxEntries: maxWatchEntries,
	})
	if err != nil {
		return nil, err
	}
	s.watch = w
	out := make(chan []string, 1)
	go func() {
		defer close(out)
		for {
			events, err := w.Next(ctx)
			if err != nil {
				return
			}
			paths := make([]string, 0, len(events))
			seen := make(map[string]bool, len(events))
			for _, ev := range events {
				p := path.Clean(strings.ReplaceAll(ev.Path, "\\", "/"))
				// Our own atomic-write temporaries are not user changes.
				if p == "." || p == ".." || strings.HasPrefix(p, "../") || seen[p] ||
					strings.HasPrefix(path.Base(p), ".omo-") {
					continue
				}
				seen[p] = true
				paths = append(paths, p)
			}
			if len(paths) == 0 {
				continue
			}
			select {
			case out <- paths:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out, nil
}

// ignoredDirs are never walked or watched: they are large, generated, and
// nobody edits them by hand.
var ignoredDirs = map[string]bool{
	".git": true, ".hg": true, ".svn": true,
	"node_modules": true, "vendor": true, "dist": true, "build": true,
	"target": true, ".venv": true, "venv": true, "__pycache__": true,
	".idea": true, ".vscode": true, ".cache": true,
}

func isIgnored(rel string, isDir bool) bool {
	if !isDir {
		return false
	}
	for _, part := range strings.Split(rel, "/") {
		if ignoredDirs[part] {
			return true
		}
	}
	return false
}

func stamp(info fs.FileInfo, data []byte) FileStamp {
	return FileStamp{
		Exists: true,
		Size:   int64(len(data)),
		Mod:    info.ModTime().UnixNano(),
		Hash:   sha256.Sum256(data),
	}
}

// tmpSuffix makes a temporary name unique without pulling in math/rand's global
// state: the process id and the wall clock are enough to avoid collisions, and
// O_EXCL catches the rest.
func tmpSuffix() string {
	return fmt.Sprintf("%d-%d.tmp", os.Getpid(), time.Now().UnixNano())
}
