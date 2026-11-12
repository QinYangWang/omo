package plugins

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func writePluginFixture(t *testing.T, dir, ui string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "ui"), 0o700); err != nil {
		t.Fatal(err)
	}
	manifest := `{
  "id": "omo.test-ui",
  "name": "Test UI",
  "version": "1.0.0",
  "apiVersion": 1,
  "permissions": ["ui.replace", "chat.read", "chat.write"],
  "ui": {"main": "ui/main.json"}
}`
	if err := os.WriteFile(filepath.Join(dir, ManifestName), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ui", "main.json"), []byte(ui), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestManagerInstallEnableAndActivate(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(t.TempDir(), "plugin")
	writePluginFixture(t, src, `{"type":"page"}`)

	manager, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := manager.InstallDir(src)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.ID != "omo.test-ui" {
		t.Fatalf("id = %q", manifest.ID)
	}
	plugin := manager.Get("omo.test-ui")
	if plugin == nil || plugin.Enabled {
		t.Fatalf("installed plugin = %#v", plugin)
	}
	if err := manager.SetActiveUI("omo.test-ui"); err == nil {
		t.Fatal("a disabled plugin must not become the UI")
	}
	if err := manager.SetEnabled("omo.test-ui", true); err != nil {
		t.Fatal(err)
	}
	if err := manager.SetActiveUI("omo.test-ui"); err != nil {
		t.Fatal(err)
	}
	if active := manager.ActiveUI(); active == nil || active.ID != "omo.test-ui" {
		t.Fatalf("active UI = %#v", active)
	}
	data, err := manager.ReadUIFile("omo.test-ui", "ui/main.json")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"type":"page"}` {
		t.Fatalf("ui = %s", data)
	}
	if err := manager.Uninstall("omo.test-ui"); err != nil {
		t.Fatal(err)
	}
	if manager.ActiveUI() != nil {
		t.Fatal("uninstall should clear the active UI")
	}
}

func TestManagerRejectsPathEscape(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(t.TempDir(), "plugin")
	writePluginFixture(t, src, `{"type":"page"}`)
	manifest := `{
  "id": "omo.escape",
  "name": "Escape",
  "version": "1.0.0",
  "apiVersion": 1,
  "permissions": ["ui.replace"],
  "ui": {"main": "../outside.json"}
}`
	if err := os.WriteFile(filepath.Join(src, ManifestName), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	manager, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.InstallDir(src); err == nil {
		t.Fatal("expected path escape to be rejected")
	}
}

func TestInstallZip(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(t.TempDir(), "plugin")
	writePluginFixture(t, src, `{"type":"page"}`)
	archive := makeZip(t, src)

	manager, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.InstallZip(archive); err != nil {
		t.Fatal(err)
	}
	if manager.Get("omo.test-ui") == nil {
		t.Fatal("plugin was not installed from zip")
	}
}

func TestArchiveRoundTrip(t *testing.T) {
	src := filepath.Join(t.TempDir(), "plugin")
	writePluginFixture(t, src, `{"type":"page"}`)

	first, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.InstallDir(src); err != nil {
		t.Fatal(err)
	}
	archive, err := first.Archive("omo.test-ui")
	if err != nil {
		t.Fatal(err)
	}

	second, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := second.InstallZip(archive); err != nil {
		t.Fatal(err)
	}
	plugin := second.Get("omo.test-ui")
	if plugin == nil {
		t.Fatal("plugin was not installed from the exported archive")
	}
	data, err := second.ReadUIFile("omo.test-ui", "ui/main.json")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"type":"page"}` {
		t.Fatalf("ui = %s", data)
	}
}

func makeZip(t *testing.T, dir string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		file, err := writer.Create(filepath.ToSlash(rel))
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		_, err = file.Write(data)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
