package documents

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/QinYangWang/omo/internal/workspace"
)

func newStore(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.go"), []byte("package a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ws, err := workspace.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ws.Close() })
	return New(ws), dir
}

func TestOpenLoadsOnceAndKeepsLanguage(t *testing.T) {
	s, _ := newStore(t)
	doc, already, err := s.Open("a.go")
	if err != nil || already {
		t.Fatalf("open = %v, already=%v", err, already)
	}
	if got := doc.Buf.String(); got != "package a\n" {
		t.Fatalf("text = %q", got)
	}
	if doc.Buf.Language() == nil || doc.Buf.Language().Name == "" {
		t.Error("language not detected from the file name")
	}
	_, already, err = s.Open("a.go")
	if err != nil || !already {
		t.Fatalf("second open = %v, already=%v", err, already)
	}
	if s.Dirty("a.go") {
		t.Error("freshly opened document is dirty")
	}
}

func TestSaveMarksCleanAndWritesThrough(t *testing.T) {
	s, dir := newStore(t)
	doc, _, err := s.Open("a.go")
	if err != nil {
		t.Fatal(err)
	}
	doc.Buf.Set("package a\n\nfunc A() {}\n")
	if !s.Dirty("a.go") {
		t.Fatal("edit did not mark the document dirty")
	}
	if err := s.Save("a.go"); err != nil {
		t.Fatal(err)
	}
	if s.Dirty("a.go") {
		t.Error("save did not clear the dirty flag")
	}
	onDisk, err := os.ReadFile(filepath.Join(dir, "a.go"))
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != "package a\n\nfunc A() {}\n" {
		t.Fatalf("disk = %q", onDisk)
	}
}

func TestSavePreservesCRLF(t *testing.T) {
	s, dir := newStore(t)
	if err := os.WriteFile(filepath.Join(dir, "w.txt"), []byte("one\r\ntwo\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	doc, _, err := s.Open("w.txt")
	if err != nil {
		t.Fatal(err)
	}
	doc.Buf.Set("one\nthree\n")
	if err := s.Save("w.txt"); err != nil {
		t.Fatal(err)
	}
	onDisk, err := os.ReadFile(filepath.Join(dir, "w.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != "one\r\nthree\r\n" {
		t.Fatalf("disk = %q, want CRLF line endings", onDisk)
	}
}

func TestSaveRefusesToClobberAnAgentEdit(t *testing.T) {
	s, dir := newStore(t)
	doc, _, err := s.Open("a.go")
	if err != nil {
		t.Fatal(err)
	}
	doc.Buf.Set("package a // editor\n")
	// An agent writes the file through the terminal.
	if err := os.WriteFile(filepath.Join(dir, "a.go"), []byte("package a // agent\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	err = s.Save("a.go")
	if !errors.Is(err, workspace.ErrConflict) {
		t.Fatalf("save = %v, want ErrConflict", err)
	}
	onDisk, _ := os.ReadFile(filepath.Join(dir, "a.go"))
	if string(onDisk) != "package a // agent\n" {
		t.Fatalf("disk was overwritten: %q", onDisk)
	}
	if !s.Dirty("a.go") {
		t.Error("buffer should still be dirty after a refused save")
	}
}

func TestReloadPicksUpDiskChanges(t *testing.T) {
	s, dir := newStore(t)
	if _, _, err := s.Open("a.go"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.go"), []byte("package b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	changed, err := s.Reload("a.go")
	if err != nil || !changed {
		t.Fatalf("reload = %v, changed=%v", err, changed)
	}
	doc, _ := s.Get("a.go")
	if got := doc.Buf.String(); got != "package b\n" {
		t.Fatalf("text = %q", got)
	}
	if changed, err := s.Reload("a.go"); err != nil || changed {
		t.Fatalf("second reload = %v, changed=%v", err, changed)
	}
}

func TestCheckDiskReportsExternalWrites(t *testing.T) {
	s, dir := newStore(t)
	if _, _, err := s.Open("a.go"); err != nil {
		t.Fatal(err)
	}
	if same, err := s.CheckDisk("a.go"); err != nil || !same {
		t.Fatalf("unchanged = %v, %v", same, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.go"), []byte("package a // x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if same, err := s.CheckDisk("a.go"); err != nil || same {
		t.Fatalf("changed = %v, %v", same, err)
	}
}

func TestCloseForgetsDocument(t *testing.T) {
	s, _ := newStore(t)
	if _, _, err := s.Open("a.go"); err != nil {
		t.Fatal(err)
	}
	s.Close("a.go")
	if _, ok := s.Get("a.go"); ok {
		t.Fatal("document still open after Close")
	}
	if s.Dirty("a.go") {
		t.Fatal("closed document reported dirty")
	}
}
