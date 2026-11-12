// Package plugins loads, validates and installs omo UI plugins.
package plugins

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	ManifestName = "omo-plugin.json"
	APIVersion   = 1
)

var pluginIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)

type Manifest struct {
	SchemaVersion int      `json:"schemaVersion,omitempty"`
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Version       string   `json:"version"`
	APIVersion    int      `json:"apiVersion"`
	Description   string   `json:"description,omitempty"`
	Author        string   `json:"author,omitempty"`
	Homepage      string   `json:"homepage,omitempty"`
	Permissions   []string `json:"permissions,omitempty"`
	UI            *UI      `json:"ui,omitempty"`
}

type UI struct {
	Main string `json:"main"`
}

type Installed struct {
	Manifest
	Dir     string `json:"-"`
	Enabled bool   `json:"enabled"`
	Error   string `json:"error,omitempty"`
}

func LoadManifest(dir string) (Manifest, error) {
	var manifest Manifest
	data, err := os.ReadFile(filepath.Join(dir, ManifestName))
	if err != nil {
		return manifest, err
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return manifest, fmt.Errorf("decode %s: %w", ManifestName, err)
	}
	if err := manifest.Validate(dir); err != nil {
		return manifest, err
	}
	return manifest, nil
}

func (m Manifest) Validate(dir string) error {
	if m.SchemaVersion != 0 && m.SchemaVersion != 1 {
		return fmt.Errorf("unsupported schemaVersion %d (want 1)", m.SchemaVersion)
	}
	if !pluginIDPattern.MatchString(m.ID) {
		return errors.New("id must use lowercase letters, digits, dots, dashes or underscores")
	}
	if strings.TrimSpace(m.Name) == "" {
		return errors.New("name is required")
	}
	if strings.TrimSpace(m.Version) == "" {
		return errors.New("version is required")
	}
	if m.APIVersion != APIVersion {
		return fmt.Errorf("unsupported apiVersion %d (want %d)", m.APIVersion, APIVersion)
	}
	permissions := map[string]bool{
		"chat.read": true, "chat.write": true, "settings.open": true,
		"workspace.choose": true, "ui.replace": true,
	}
	for _, permission := range m.Permissions {
		if !permissions[permission] {
			return fmt.Errorf("unknown permission %q", permission)
		}
	}
	if m.UI != nil {
		if !hasPermission(m.Permissions, "ui.replace") {
			return errors.New("ui.main requires the ui.replace permission")
		}
		if err := validateRelativeFile(dir, m.UI.Main); err != nil {
			return fmt.Errorf("ui.main: %w", err)
		}
	}
	return nil
}

func hasPermission(permissions []string, want string) bool {
	for _, permission := range permissions {
		if permission == want {
			return true
		}
	}
	return false
}

func validateRelativeFile(dir, name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return errors.New("path is empty")
	}
	if filepath.IsAbs(name) {
		return errors.New("path must be relative")
	}
	clean := filepath.Clean(name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return errors.New("path escapes the plugin directory")
	}
	info, err := os.Stat(filepath.Join(dir, clean))
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("path is not a regular file")
	}
	return nil
}
