package diff

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/QinYangWang/omo/internal/git"
	"github.com/QinYangWang/omo/internal/workspace"
)

func setup(t *testing.T, content string) (*git.Repo, *workspace.Service, string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "main.go")
	if err := os.WriteFile(path, []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"init", "--initial-branch=main", "."},
		{"add", "."},
		{"commit", "-m", "initial"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com",
			"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	if content != "" {
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	repo, err := git.Detect(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	ws, err := workspace.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ws.Close() })
	return repo, ws, dir
}

func TestFromGitComparesHeadWithDisk(t *testing.T) {
	repo, ws, _ := setup(t, "package main\n\nfunc main() {}\n")
	r, err := FromGit(context.Background(), repo, ws, "main.go")
	if err != nil {
		t.Fatal(err)
	}
	if r.Old != "package main\n" {
		t.Errorf("old = %q", r.Old)
	}
	if r.New != "package main\n\nfunc main() {}\n" {
		t.Errorf("new = %q", r.New)
	}
	if !r.Changed() || r.NewFile {
		t.Errorf("changed=%v newFile=%v", r.Changed(), r.NewFile)
	}
}

func TestFromGitNewFile(t *testing.T) {
	repo, ws, dir := setup(t, "")
	if err := os.WriteFile(filepath.Join(dir, "added.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := FromGit(context.Background(), repo, ws, "added.go")
	if err != nil {
		t.Fatal(err)
	}
	if !r.NewFile || r.Old != "" || r.New != "package main\n" {
		t.Fatalf("review = %+v", r)
	}
}

func TestSaveAppliesAndDetectsLaterWrites(t *testing.T) {
	repo, ws, dir := setup(t, "package main // agent\n")
	r, err := FromGit(context.Background(), repo, ws, "main.go")
	if err != nil {
		t.Fatal(err)
	}
	// The user reverts the change in the diff view: New becomes Old again.
	r.New = r.Old
	if _, err := Save(ws, r); err != nil {
		t.Fatal(err)
	}
	onDisk, err := os.ReadFile(filepath.Join(dir, "main.go"))
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != "package main\n" {
		t.Fatalf("disk = %q", onDisk)
	}

	// A second review, then someone else writes: saving must refuse.
	r2, err := FromGit(context.Background(), repo, ws, "main.go")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main // later\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Save(ws, r2); !errors.Is(err, workspace.ErrConflict) {
		t.Fatalf("save after a later write = %v, want ErrConflict", err)
	}
}

func TestFromBuffer(t *testing.T) {
	r := FromBuffer("a.go", "saved\n", "edited\n", workspace.FileStamp{Exists: true})
	if !r.Changed() || r.Old != "saved\n" || r.New != "edited\n" {
		t.Fatalf("review = %+v", r)
	}
	same := FromBuffer("a.go", "x\n", "x\n", workspace.FileStamp{})
	if same.Changed() {
		t.Error("identical text reported as changed")
	}
}
