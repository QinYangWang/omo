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
)

type Settings struct {
	Provider    string  `json:"provider"`
	BaseURL     string  `json:"baseUrl"`
	Model       string  `json:"model"`
	Temperature float64 `json:"temperature"`
	MaxTokens   int     `json:"maxTokens"`
	Workspace   string  `json:"workspace"`
}

func Defaults() Settings {
	return Settings{
		Provider:    "openai-compatible",
		BaseURL:     "https://api.openai.com/v1",
		Model:       "gpt-4.1-mini",
		Temperature: 0.7,
		MaxTokens:   4096,
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
		if err := json.Unmarshal(data, &cfg.Settings); err != nil {
			return nil, fmt.Errorf("read settings: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if cfg.Settings.BaseURL == "" {
		cfg.Settings.BaseURL = Defaults().BaseURL
	}
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
	if c.Settings.Provider == "openai-compatible" {
		return c.Settings.BaseURL != ""
	}
	return c.Credential(c.Settings.Provider) != ""
}
