package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// newTestWorkspace builds a temporary tree and opens it as a workspace.
func newTestWorkspace(t *testing.T) *Service {
	t.Helper()
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "README.md"), "# hello\n")
	if err := os.MkdirAll(filepath.Join(dir, "internal", "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(dir, "internal", "app", "app.go"), "package app\n")
	mustWrite(t, filepath.Join(dir, "internal", "z.txt"), "z\n")
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCanonicalRejectsEscapes(t *testing.T) {
	s := newTestWorkspace(t)
	for _, bad := range []string{
		"", ".", "..", "../x", "a/../../b", "/etc/passwd", `C:\Windows\win.ini`,
		`\\server\share\file`, "internal/../../etc/passwd", "   ",
	} {
		if _, err := s.Canonical(bad); !errors.Is(err, ErrOutside) {
			t.Errorf("Canonical(%q) = %v, want ErrOutside", bad, err)
		}
	}
	good := map[string]string{
		"README.md":           "README.md",
		"internal/app/app.go": "internal/app/app.go",
		`internal\app\app.go`: "internal/app/app.go",
		"./internal/./app/x":  "internal/app/x",
		"internal/app/../app": "internal/app",
	}
	for in, want := range good {
		got, err := s.Canonical(in)
		if err != nil || got != want {
			t.Errorf("Canonical(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
}

func TestListIsLazySortedAndHidesNothing(t *testing.T) {
	s := newTestWorkspace(t)
	root, err := s.List("")
	if err != nil {
		t.Fatal(err)
	}
	// Directories first, then names, case-insensitively.
	if len(root) < 2 || !root[0].IsDir || root[0].Name != "internal" {
		t.Fatalf("root listing = %+v", root)
	}
	sub, err := s.List("internal")
	if err != nil {
		t.Fatal(err)
	}
	if len(sub) != 2 || sub[0].Name != "app" || sub[1].Name != "z.txt" {
		t.Fatalf("internal listing = %+v", sub)
	}
	if sub[0].Rel != "internal/app" {
		t.Errorf("rel = %q", sub[0].Rel)
	}
}

func TestReadWriteRoundTrip(t *testing.T) {
	s := newTestWorkspace(t)
	data, st, err := s.Read("README.md")
	if err != nil || string(data) != "# hello\n" || !st.Exists {
		t.Fatalf("read = %q, %+v, %v", data, st, err)
	}
	next, err := s.Write("README.md", []byte("# bye\r\n"), st)
	if err != nil {
		t.Fatal(err)
	}
	if !next.Exists || next.Hash == st.Hash {
		t.Errorf("stamp did not change: %+v", next)
	}
	back, _, err := s.Read("README.md")
	if err != nil || string(back) != "# bye\r\n" {
		t.Fatalf("re-read = %q, %v", back, err)
	}
	// The atomic write leaves no temporary behind.
	entries, err := s.List("")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name, ".omo-") {
			t.Errorf("temporary file left behind: %s", e.Name)
		}
	}
}

func TestWriteDetectsConflict(t *testing.T) {
	s := newTestWorkspace(t)
	_, stale, err := s.Read("README.md")
	if err != nil {
		t.Fatal(err)
	}
	// Someone else writes the same file after we read it.
	mustWrite(t, filepath.Join(s.Path(), "README.md"), "agent wrote this\n")

	if _, err := s.Write("README.md", []byte("editor wins\n"), stale); !errors.Is(err, ErrConflict) {
		t.Fatalf("write over a changed file = %v, want ErrConflict", err)
	}
	// The file on disk is untouched.
	data, _, err := s.Read("README.md")
	if err != nil || string(data) != "agent wrote this\n" {
		t.Fatalf("disk = %q, %v", data, err)
	}
}

func TestWriteConflictSameSizeAndModTime(t *testing.T) {
	s := newTestWorkspace(t)
	dir := s.Path()
	path := filepath.Join(dir, "same.txt")
	mustWrite(t, path, "AAAA\n")
	_, st, err := s.Read("same.txt")
	if err != nil {
		t.Fatal(err)
	}
	// Same size, and a timestamp forced back to the value we read: only the
	// hash can tell the content apart.
	mustWrite(t, path, "BBBB\n")
	if err := os.Chtimes(path, time.Unix(0, st.Mod), time.Unix(0, st.Mod)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write("same.txt", []byte("CCCC\n"), st); !errors.Is(err, ErrConflict) {
		t.Fatalf("same-size conflict = %v, want ErrConflict", err)
	}
}

func TestReadRefusesNonRegularAndLargeFiles(t *testing.T) {
	s := newTestWorkspace(t)
	big := filepath.Join(s.Path(), "big.bin")
	f, err := os.Create(big)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(MaxFileBytes + 1); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if _, _, err := s.Read("big.bin"); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("large file = %v, want ErrTooLarge", err)
	}
	if _, err := s.Write("big.bin", make([]byte, MaxFileBytes+1), FileStamp{}); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("large write = %v, want ErrTooLarge", err)
	}

	if runtime.GOOS == "windows" {
		return // no portable FIFO to test with
	}
	fifo := filepath.Join(s.Path(), "pipe")
	if err := mkfifo(fifo); err != nil {
		t.Skipf("mkfifo: %v", err)
	}
	if _, _, err := s.Read("pipe"); !errors.Is(err, ErrNotRegular) {
		t.Fatalf("fifo = %v, want ErrNotRegular", err)
	}
}

func TestSymlinkOutOfRootIsRefused(t *testing.T) {
	s := newTestWorkspace(t)
	outside := filepath.Join(t.TempDir(), "secret.txt")
	mustWrite(t, outside, "secret\n")
	link := filepath.Join(s.Path(), "escape.txt")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink not permitted here: %v", err)
	}
	if _, _, err := s.Read("escape.txt"); err == nil {
		t.Fatal("reading a symlink that leaves the workspace succeeded")
	}
	// os.Root also refuses absolute symlink targets, even ones that resolve
	// inside the root ("Symbolic links must not be absolute"), so a relative
	// link is the only kind that works. Document it and test that case.
	if _, _, err := s.Read("escape.txt"); err == nil {
		t.Fatal("absolute symlink target was followed")
	}
	inside := filepath.Join(s.Path(), "alias.md")
	if err := os.Symlink("README.md", inside); err != nil {
		t.Skipf("symlink not permitted here: %v", err)
	}
	data, _, err := s.Read("alias.md")
	if err != nil || !strings.Contains(string(data), "hello") {
		t.Fatalf("relative in-root symlink read = %q, %v", data, err)
	}
}

func TestStatAndVerifyTrackEdits(t *testing.T) {
	s := newTestWorkspace(t)
	_, st, err := s.Read("README.md")
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := s.Verify("README.md", st); err != nil || !ok {
		t.Fatalf("verify unchanged = %v, %v", ok, err)
	}
	mustWrite(t, filepath.Join(s.Path(), "README.md"), "# changed\n")
	if ok, err := s.Verify("README.md", st); err != nil || ok {
		t.Fatalf("verify changed = %v, %v", ok, err)
	}
	if _, err := s.Stat("nope.txt"); err == nil {
		t.Fatal("stat of a missing file succeeded")
	}
}

func TestWatchReportsChanges(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "a.txt"), "a\n")
	if err := os.MkdirAll(filepath.Join(dir, "node_modules", "x"), 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ch, err := s.Watch(ctx)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond) // let the watch enroll
	mustWrite(t, filepath.Join(dir, "b.txt"), "b\n")
	mustWrite(t, filepath.Join(dir, "node_modules", "x", "ignored.txt"), "n\n")

	select {
	case paths := <-ch:
		found := false
		for _, p := range paths {
			if p == "b.txt" {
				found = true
			}
			if strings.Contains(p, "node_modules") {
				t.Errorf("ignored directory reported: %s", p)
			}
		}
		if !found {
			t.Errorf("b.txt missing from %v", paths)
		}
	case <-ctx.Done():
		t.Fatal("no watch event within 10s")
	}
}

func TestOpenRejectsFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file.txt")
	mustWrite(t, path, "x")
	if _, err := Open(path); err == nil {
		t.Fatal("opening a file as a workspace succeeded")
	}
}
