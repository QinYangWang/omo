// Package config stores the app's settings on disk.
//
// The API key lives in a separate file next to settings.json. The POC does
// not use the system keychain yet: Unix gets file mode 0600, while Windows
// relies on the ACL of the user's profile directory.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Appearance values the settings offer.
const (
	AppearanceSystem = "system"
	AppearanceLight  = "light"
	AppearanceDark   = "dark"
)

// Appearances are the choices, in the order the settings show them.
var Appearances = []string{AppearanceSystem, AppearanceLight, AppearanceDark}

// NormalizeAppearance keeps a known value, or follows the system.
func NormalizeAppearance(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	for _, known := range Appearances {
		if value == known {
			return value
		}
	}
	return AppearanceSystem
}

type CustomProvider struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	BaseURL string   `json:"baseUrl"`
	Models  []string `json:"models,omitempty"`
}

type Settings struct {
	Provider   string `json:"provider"`
	Appearance string `json:"appearance,omitempty"`
	Model      string `json:"model"`
	MaxTokens  int    `json:"maxTokens"`
	Workspace  string `json:"workspace"`
	// Thinking is the level chosen per "provider/model".
	Thinking map[string]string `json:"thinking,omitempty"`
	// CustomProviders are user-added OpenAI-compatible endpoints.
	CustomProviders []CustomProvider `json:"customProviders,omitempty"`
	// BaseURL is the single endpoint of older versions; Load turns it into
	// the first CustomProviders entry.
	BaseURL string `json:"baseUrl,omitempty"`
}

func Defaults() Settings {
	return Settings{
		Provider:   "openai",
		Appearance: "system",
		Model:      "gpt-4.1-mini",
		MaxTokens:  4096,
		Thinking:   map[string]string{},
	}
}

type Config struct {
	dir         string
	Settings    Settings
	Credentials map[string]string
}

func Load(dir string) (*Config, error) {
	cfg := &Config{dir: dir, Settings: Defaults(), Credentials: map[string]string{}}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err == nil {
		// Older settings stored the thinking level as one string; drop it so
		// the per-model map decodes.
		var probe map[string]json.RawMessage
		if json.Unmarshal(data, &probe) == nil {
			if raw, ok := probe["thinking"]; ok && len(raw) > 0 && raw[0] == '"' {
				delete(probe, "thinking")
				data, _ = json.Marshal(probe)
			}
		}
		if err := json.Unmarshal(data, &cfg.Settings); err != nil {
			return nil, fmt.Errorf("read settings: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	cfg.Settings.Appearance = NormalizeAppearance(cfg.Settings.Appearance)
	if cfg.Settings.Thinking == nil {
		cfg.Settings.Thinking = map[string]string{}
	}
	// One custom endpoint used to live in BaseURL; make it the first provider.
	if len(cfg.Settings.CustomProviders) == 0 && strings.TrimSpace(cfg.Settings.BaseURL) != "" {
		cfg.Settings.CustomProviders = append(cfg.Settings.CustomProviders, CustomProvider{
			ID: "openai-compatible", Name: "OpenAI-compatible",
			BaseURL: strings.TrimRight(strings.TrimSpace(cfg.Settings.BaseURL), "/"),
		})
	}
	cfg.Settings.BaseURL = ""
	if cfg.Settings.Model == "" {
		cfg.Settings.Model = Defaults().Model
	}
	if cfg.Settings.Provider == "" {
		cfg.Settings.Provider = Defaults().Provider
	}
	if cfg.Settings.MaxTokens <= 0 {
		cfg.Settings.MaxTokens = Defaults().MaxTokens
	}
	credentialData, err := os.ReadFile(filepath.Join(dir, "credentials.json"))
	if err == nil {
		if err := json.Unmarshal(credentialData, &cfg.Credentials); err != nil {
			return nil, fmt.Errorf("read credentials: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if cfg.Credentials[cfg.Settings.Provider] == "" {
		legacy, err := os.ReadFile(filepath.Join(dir, "api-key"))
		if err == nil {
			cfg.Credentials[cfg.Settings.Provider] = string(legacy)
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	return cfg, nil
}

func (c *Config) Dir() string { return c.dir }

func (c *Config) Save() error {
	if err := os.MkdirAll(c.dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c.Settings, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(c.dir, "settings.json"), data, 0o600); err != nil {
		return err
	}
	if len(c.Credentials) > 0 {
		data, err := json.MarshalIndent(c.Credentials, "", "  ")
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(c.dir, "credentials.json"), data, 0o600); err != nil {
			return err
		}
		if runtime.GOOS != "windows" {
			_ = os.Chmod(filepath.Join(c.dir, "credentials.json"), 0o600)
		}
	}
	_ = os.Remove(filepath.Join(c.dir, "api-key"))
	return nil
}

func (c *Config) Credential(provider string) string {
	return c.Credentials[provider]
}

func (c *Config) SetCredential(provider, key string) {
	if key == "" {
		delete(c.Credentials, provider)
		return
	}
	c.Credentials[provider] = key
}

func (c *Config) Ready() bool {
	if c.Settings.Provider == "" || c.Settings.Model == "" {
		return false
	}
	for _, provider := range c.Settings.CustomProviders {
		if provider.ID == c.Settings.Provider {
			return provider.BaseURL != ""
		}
	}
	return c.Credential(c.Settings.Provider) != ""
}
