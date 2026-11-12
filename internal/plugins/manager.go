package plugins

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const maxPluginBytes = 64 << 20

type stateFile struct {
	Enabled  map[string]bool `json:"enabled"`
	ActiveUI string          `json:"activeUi,omitempty"`
}

type Manager struct {
	root      string
	installed map[string]*Installed
	state     stateFile
}

func Open(root string) (*Manager, error) {
	m := &Manager{
		root:      root,
		installed: map[string]*Installed{},
		state:     stateFile{Enabled: map[string]bool{}},
	}
	if err := os.MkdirAll(filepath.Join(root, "plugins"), 0o700); err != nil {
		return nil, err
	}
	if data, err := os.ReadFile(filepath.Join(root, "plugins", "state.json")); err == nil {
		if err := json.Unmarshal(data, &m.state); err != nil {
			return nil, fmt.Errorf("read plugin state: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if m.state.Enabled == nil {
		m.state.Enabled = map[string]bool{}
	}
	if err := m.reload(); err != nil {
		return nil, err
	}
	return m, nil
}

func (m *Manager) Root() string { return filepath.Join(m.root, "plugins") }

func (m *Manager) reload() error {
	entries, err := os.ReadDir(m.Root())
	if err != nil {
		return err
	}
	installed := map[string]*Installed{}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		dir := filepath.Join(m.Root(), entry.Name())
		manifest, err := LoadManifest(dir)
		if err != nil {
			continue
		}
		installed[manifest.ID] = &Installed{
			Manifest: manifest,
			Dir:      dir,
			Enabled:  m.state.Enabled[manifest.ID],
		}
	}
	m.installed = installed
	m.validatedActiveUI()
	return nil
}

func (m *Manager) List() []Installed {
	out := make([]Installed, 0, len(m.installed))
	for _, plugin := range m.installed {
		out = append(out, *plugin)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (m *Manager) Get(id string) *Installed {
	plugin := m.installed[id]
	if plugin == nil {
		return nil
	}
	copy := *plugin
	return &copy
}

func (m *Manager) ActiveUI() *Installed {
	if m.state.ActiveUI == "" {
		return nil
	}
	plugin := m.installed[m.state.ActiveUI]
	if plugin == nil || !plugin.Enabled || plugin.UI == nil {
		return nil
	}
	copy := *plugin
	return &copy
}

func (m *Manager) ActiveUIID() string { return m.state.ActiveUI }

func (m *Manager) SetActiveUI(id string) error {
	if id == "" {
		m.state.ActiveUI = ""
		return m.saveState()
	}
	plugin := m.installed[id]
	if plugin == nil {
		return fmt.Errorf("plugin %q is not installed", id)
	}
	if !plugin.Enabled {
		return fmt.Errorf("plugin %q is disabled", id)
	}
	if plugin.UI == nil {
		return fmt.Errorf("plugin %q has no UI", id)
	}
	m.state.ActiveUI = id
	return m.saveState()
}

func (m *Manager) SetEnabled(id string, enabled bool) error {
	plugin := m.installed[id]
	if plugin == nil {
		return fmt.Errorf("plugin %q is not installed", id)
	}
	plugin.Enabled = enabled
	m.state.Enabled[id] = enabled
	if !enabled && m.state.ActiveUI == id {
		m.state.ActiveUI = ""
	}
	return m.saveState()
}

func (m *Manager) Uninstall(id string) error {
	plugin := m.installed[id]
	if plugin == nil {
		return fmt.Errorf("plugin %q is not installed", id)
	}
	if err := os.RemoveAll(plugin.Dir); err != nil {
		return err
	}
	delete(m.installed, id)
	delete(m.state.Enabled, id)
	if m.state.ActiveUI == id {
		m.state.ActiveUI = ""
	}
	return m.saveState()
}

func (m *Manager) ReadUIFile(id, name string) ([]byte, error) {
	plugin := m.installed[id]
	if plugin == nil {
		return nil, fmt.Errorf("plugin %q is not installed", id)
	}
	if err := validateRelativeFile(plugin.Dir, name); err != nil {
		return nil, err
	}
	return os.ReadFile(filepath.Join(plugin.Dir, filepath.Clean(name)))
}

// Archive packs an installed plugin into a ZIP whose root is the plugin
// directory. The result can be installed with InstallZip on another machine.
func (m *Manager) Archive(id string) ([]byte, error) {
	plugin := m.installed[id]
	if plugin == nil {
		return nil, fmt.Errorf("plugin %q is not installed", id)
	}
	var paths []string
	var total int64
	err := filepath.WalkDir(plugin.Dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("plugin contains a symbolic link: %s", path)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("plugin contains a non-regular file: %s", path)
		}
		total += info.Size()
		if total > maxPluginBytes {
			return errors.New("plugin directory is too large")
		}
		rel, err := filepath.Rel(plugin.Dir, path)
		if err != nil {
			return err
		}
		paths = append(paths, rel)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(paths)

	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, rel := range paths {
		data, err := os.ReadFile(filepath.Join(plugin.Dir, rel))
		if err != nil {
			_ = writer.Close()
			return nil, err
		}
		file, err := writer.Create(filepath.ToSlash(rel))
		if err != nil {
			_ = writer.Close()
			return nil, err
		}
		if _, err := file.Write(data); err != nil {
			_ = writer.Close()
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	if buffer.Len() > maxPluginBytes {
		return nil, errors.New("plugin archive is too large")
	}
	return buffer.Bytes(), nil
}

func (m *Manager) InstallDir(src string) (Manifest, error) {
	staging, err := os.MkdirTemp(m.Root(), ".staging-")
	if err != nil {
		return Manifest{}, err
	}
	defer os.RemoveAll(staging)
	if err := copyTree(src, staging); err != nil {
		return Manifest{}, err
	}
	return m.installStaged(staging)
}

func (m *Manager) InstallZip(data []byte) (Manifest, error) {
	if len(data) == 0 || len(data) > maxPluginBytes {
		return Manifest{}, fmt.Errorf("plugin archive must be between 1 byte and %d bytes", maxPluginBytes)
	}
	staging, err := os.MkdirTemp(m.Root(), ".staging-")
	if err != nil {
		return Manifest{}, err
	}
	defer os.RemoveAll(staging)
	if err := unzip(data, staging); err != nil {
		return Manifest{}, err
	}
	return m.installStaged(staging)
}

func (m *Manager) installStaged(staging string) (Manifest, error) {
	manifest, err := LoadManifest(staging)
	if err != nil {
		return Manifest{}, err
	}
	destination := filepath.Join(m.Root(), manifest.ID)
	backup := destination + ".old"
	_ = os.RemoveAll(backup)
	if _, err := os.Stat(destination); err == nil {
		if err := os.Rename(destination, backup); err != nil {
			return Manifest{}, err
		}
	}
	if err := os.Rename(staging, destination); err != nil {
		_ = os.Rename(backup, destination)
		return Manifest{}, err
	}
	_ = os.RemoveAll(backup)
	enabled := m.state.Enabled[manifest.ID]
	if _, existed := m.installed[manifest.ID]; !existed {
		enabled = false
	}
	m.state.Enabled[manifest.ID] = enabled
	m.installed[manifest.ID] = &Installed{Manifest: manifest, Dir: destination, Enabled: enabled}
	if m.state.ActiveUI == manifest.ID && manifest.UI == nil {
		m.state.ActiveUI = ""
	}
	if err := m.saveState(); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func (m *Manager) saveState() error {
	data, err := json.MarshalIndent(m.state, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(m.Root(), "state.json"), data, 0o600)
}

func (m *Manager) validatedActiveUI() {
	if m.state.ActiveUI == "" {
		return
	}
	plugin := m.installed[m.state.ActiveUI]
	if plugin == nil || !plugin.Enabled || plugin.UI == nil {
		m.state.ActiveUI = ""
	}
}

func copyTree(src, dst string) error {
	var total int64
	err := filepath.WalkDir(src, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		target := filepath.Join(dst, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		if total > maxPluginBytes {
			return errors.New("plugin directory is too large")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o600)
	})
	return err
}

func unzip(data []byte, dst string) error {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	var total int64
	for _, file := range reader.File {
		name := filepath.Clean(file.Name)
		if name == "." || filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, ".."+string(filepath.Separator)) {
			return fmt.Errorf("unsafe archive path %q", file.Name)
		}
		target := filepath.Join(dst, name)
		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
			continue
		}
		if file.UncompressedSize64 > maxPluginBytes {
			return fmt.Errorf("archive member %q is too large", name)
		}
		total += int64(file.UncompressedSize64)
		if total > maxPluginBytes {
			return errors.New("archive expands beyond the plugin size limit")
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		src, err := file.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
		if err != nil {
			src.Close()
			return err
		}
		_, copyErr := io.Copy(out, io.LimitReader(src, maxPluginBytes+1))
		closeErr := out.Close()
		src.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}
