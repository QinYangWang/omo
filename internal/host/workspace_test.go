package host

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func newWorkspace(t *testing.T) (*Workspace, string, string) {
	t.Helper()
	parent := t.TempDir()
	root := filepath.Join(parent, "ws")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(parent, "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	ws, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	return ws, root, outside
}

func TestResolveRejectsParentTraversal(t *testing.T) {
	ws, _, _ := newWorkspace(t)
	for _, p := range []string{"../outside/secret.txt", "a/../../outside/secret.txt", `..\outside\secret.txt`} {
		if _, err := ws.Resolve(p); err == nil {
			t.Fatalf("Resolve(%q) should fail", p)
		}
	}
}

func TestResolveRejectsAbsoluteOutside(t *testing.T) {
	ws, _, outside := newWorkspace(t)
	if _, err := ws.Resolve(filepath.Join(outside, "secret.txt")); err == nil {
		t.Fatal("absolute path outside the workspace should fail")
	}
}

func TestReadStaysInside(t *testing.T) {
	ws, root, _ := newWorkspace(t)
	if err := os.WriteFile(filepath.Join(root, "ok.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := ws.Read("ok.txt", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if res.Text != "hello" {
		t.Fatalf("text = %q", res.Text)
	}
	if _, err := ws.Read("../outside/secret.txt", 0, 0); err == nil {
		t.Fatal("reading outside the workspace should fail")
	}
}

func TestWriteCreatesFreshFileInside(t *testing.T) {
	ws, root, _ := newWorkspace(t)
	res, err := ws.Write("docs/new/deep.txt", "created")
	if err != nil {
		t.Fatal(err)
	}
	if res.Bytes != len("created") {
		t.Fatalf("bytes = %d", res.Bytes)
	}
	data, err := os.ReadFile(filepath.Join(root, "docs", "new", "deep.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "created" {
		t.Fatalf("content = %q", data)
	}
	if _, err := ws.Write("../escaped.txt", "nope"); err == nil {
		t.Fatal("writing outside the workspace should fail")
	}
}

func TestSymlinkEscapeIsRejected(t *testing.T) {
	if runtime.GOOS == "windows" {
		// Creating symlinks on Windows needs Developer Mode or elevation;
		// try anyway and skip when the OS refuses.
	}
	ws, root, outside := newWorkspace(t)
	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("cannot create symlink: %v", err)
	}
	if _, err := ws.Resolve("link/secret.txt"); err == nil {
		t.Fatal("symlink escape should fail")
	}
	if _, err := ws.Write("link/secret.txt", "overwritten"); err == nil {
		t.Fatal("write through an escaping symlink should fail")
	}
	data, err := os.ReadFile(filepath.Join(outside, "secret.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(data)) != "secret" {
		t.Fatalf("outside file was modified: %q", data)
	}
}

func TestSearchAndList(t *testing.T) {
	ws, root, _ := newWorkspace(t)
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package main\n// needle here\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	list, err := ws.List(".")
	if err != nil {
		t.Fatal(err)
	}
	if list.Count == 0 {
		t.Fatal("expected entries")
	}
	res, err := ws.Search("needle", ".", 10)
	if err != nil {
		t.Fatal(err)
	}
	if res.Matches == 0 {
		t.Fatal("expected a match")
	}
}
