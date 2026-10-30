package git

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// newRepo creates a repository with one committed file and returns its path.
func newRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
			"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
			"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "--initial-branch=main", ".")
	if err := os.MkdirAll(filepath.Join(dir, "internal"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "internal", "a.go"), []byte("package a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "initial")
	return dir
}

func TestDetectAndBranch(t *testing.T) {
	dir := newRepo(t)
	repo, err := Detect(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := filepath.Base(repo.Root()); got != filepath.Base(dir) {
		t.Errorf("root = %q", repo.Root())
	}
	branch, err := repo.Branch(context.Background())
	if err != nil || branch != "main" {
		t.Fatalf("branch = %q, %v", branch, err)
	}
}

func TestDetectOutsideARepo(t *testing.T) {
	dir := t.TempDir()
	if _, err := Detect(context.Background(), dir); err != ErrNotRepo {
		t.Fatalf("detect = %v, want ErrNotRepo", err)
	}
}

func TestStatusListsModifiedAndUntracked(t *testing.T) {
	dir := newRepo(t)
	repo, err := Detect(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "internal", "a.go"), []byte("package a // edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "new file.md"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	changes, err := repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, c := range changes {
		got[c.Path] = c.Status
	}
	if got["internal/a.go"] != "M" {
		t.Errorf("modified file = %q (all: %v)", got["internal/a.go"], got)
	}
	if got["new file.md"] != "?" {
		t.Errorf("untracked file = %q (all: %v)", got["new file.md"], got)
	}
}

func TestHeadText(t *testing.T) {
	dir := newRepo(t)
	repo, err := Detect(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	text, inHead, err := repo.HeadText(context.Background(), "internal/a.go")
	if err != nil || !inHead || text != "package a\n" {
		t.Fatalf("head text = %q, inHead=%v, err=%v", text, inHead, err)
	}
	text, inHead, err = repo.HeadText(context.Background(), "missing.txt")
	if err != nil || inHead || text != "" {
		t.Fatalf("missing file = %q, inHead=%v, err=%v", text, inHead, err)
	}
}

func TestWorkspaceInSubdirectory(t *testing.T) {
	dir := newRepo(t)
	sub := filepath.Join(dir, "internal")
	repo, err := Detect(context.Background(), sub)
	if err != nil {
		t.Fatal(err)
	}
	if repo.Prefix() != "internal" {
		t.Fatalf("prefix = %q, want internal", repo.Prefix())
	}
	changes, err := repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 0 {
		t.Fatalf("clean subdirectory reported %v", changes)
	}
	if err := os.WriteFile(filepath.Join(sub, "a.go"), []byte("package a // x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	changes, err = repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 1 || changes[0].Path != "a.go" {
		t.Fatalf("subdirectory status = %v, want [{a.go M}]", changes)
	}
	text, inHead, err := repo.HeadText(context.Background(), "a.go")
	if err != nil || !inHead || text != "package a\n" {
		t.Fatalf("subdirectory head text = %q, inHead=%v, %v", text, inHead, err)
	}
}

func TestAddAllStagesWithoutShellOrParentPaths(t *testing.T) {
	dir := newRepo(t)
	sub := filepath.Join(dir, "internal")
	repo, err := Detect(context.Background(), sub)
	if err != nil {
		t.Fatal(err)
	}
	// Names a shell would split, expand or execute, and one that reads as an
	// option.
	names := []string{
		"space name.txt",
		"quote ' name.txt",
		"semi ; touch pwned.txt",
		"$(touch pwned2).txt",
		"-dash.txt",
	}
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(sub, name), []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "parent.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := repo.AddAll(context.Background()); err != nil {
		t.Fatal(err)
	}

	changes, err := repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	staged := make(map[string]bool, len(changes))
	for _, c := range changes {
		staged[c.Path] = c.Staged
	}
	for _, name := range names {
		if !staged[name] {
			t.Errorf("%q was not staged; changes = %v", name, changes)
		}
	}
	// The pathspec kept the parent directory out of the index.
	root, err := Detect(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	all, err := root.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range all {
		if c.Path == "parent.txt" && c.Staged {
			t.Errorf("a workspace in a subdirectory staged its parent's file: %v", all)
		}
	}
	for _, injected := range []string{"pwned.txt", "pwned2", ".txt"} {
		if _, err := os.Stat(filepath.Join(sub, injected)); err == nil {
			t.Errorf("a file name reached a shell: %q exists", injected)
		}
	}
}

func TestAddAllStagesARename(t *testing.T) {
	dir := newRepo(t)
	repo, err := Detect(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(dir, "internal", "a.go"), filepath.Join(dir, "internal", "b.go")); err != nil {
		t.Fatal(err)
	}
	if err := repo.AddAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	changes, err := repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 1 || changes[0].Path != "internal/b.go" || changes[0].Status != "R" || !changes[0].Staged {
		t.Fatalf("rename = %v, want one staged R at internal/b.go", changes)
	}
}

func TestStatusReportsStagedAndUnstaged(t *testing.T) {
	dir := newRepo(t)
	repo, err := Detect(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "internal", "a.go")
	if err := os.WriteFile(file, []byte("package a // x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	changes, err := repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 1 || changes[0].Staged {
		t.Fatalf("before add = %v, want one unstaged change", changes)
	}
	if err := repo.AddAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	changes, err = repo.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 1 || !changes[0].Staged || changes[0].Status != "M" {
		t.Fatalf("after add = %v, want one staged M", changes)
	}
}
