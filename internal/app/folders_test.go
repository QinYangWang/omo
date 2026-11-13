package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QinYangWang/omo/internal/bots"
	"github.com/QinYangWang/omo/internal/config"
)

func TestCopyAttachment(t *testing.T) {
	root := t.TempDir()
	srcDir := t.TempDir()
	src := filepath.Join(srcDir, "notes.txt")
	if err := os.WriteFile(src, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	first, err := copyAttachment(root, "b1", src)
	if err != nil {
		t.Fatal(err)
	}
	if first.Path != ".omo/uploads/b1/notes.txt" {
		t.Errorf("path %q, want .omo/uploads/b1/notes.txt", first.Path)
	}
	if data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(first.Path))); err != nil || string(data) != "hello" {
		t.Errorf("copied file = %q, %v", data, err)
	}

	second, err := copyAttachment(root, "b1", src)
	if err != nil {
		t.Fatal(err)
	}
	if second.Name != "notes-2.txt" {
		t.Errorf("second copy %q, want notes-2.txt, so files are not overwritten", second.Name)
	}

	if _, err := copyAttachment(root, "b1", srcDir); err == nil {
		t.Error("a folder was accepted as an attachment")
	}
}

func TestAttachmentNoteListsPaths(t *testing.T) {
	note := attachmentNote("look", []Attachment{{Name: "a.txt", Path: ".omo/uploads/b1/a.txt", Size: 3}})
	if !strings.Contains(note, "look") || !strings.Contains(note, ".omo/uploads/b1/a.txt") {
		t.Errorf("note %q does not list the attached file", note)
	}
}

func TestGuardedFolderRefusesDataDir(t *testing.T) {
	data := t.TempDir()
	cfg, err := config.Load(data)
	if err != nil {
		t.Fatal(err)
	}
	a := &App{Config: cfg}
	if err := a.guardedFolder(filepath.Join(data, "teams")); err == nil {
		t.Error("a folder inside the data dir was accepted")
	}
	if err := a.guardedFolder(filepath.Dir(data)); err == nil {
		t.Error("the data dir's parent was accepted")
	}
	if err := a.guardedFolder(t.TempDir()); err != nil {
		t.Errorf("an unrelated folder was refused: %v", err)
	}
}

func TestSetBotFolder(t *testing.T) {
	data := t.TempDir()
	cfg, err := config.Load(data)
	if err != nil {
		t.Fatal(err)
	}
	store, err := bots.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	bot, err := store.AddBot(bots.Bot{Name: "Chief", Role: bots.RoleMain, Permission: bots.PermissionWorkspace})
	if err != nil {
		t.Fatal(err)
	}
	a := &App{Config: cfg, Bots: store}
	folder := t.TempDir()

	if err := a.SetBotFolder(bot.ID, folder); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.Bot(bot.ID); got.Folder == "" {
		t.Error("the Bot's folder was not stored")
	}
	if err := a.SetBotFolder(bot.ID, data); err == nil {
		t.Error("the data dir was accepted as a Bot folder")
	}
	if err := a.SetBotFolder(bot.ID, ""); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.Bot(bot.ID); got.Folder != "" {
		t.Errorf("folder %q after reset, want empty", got.Folder)
	}
}
