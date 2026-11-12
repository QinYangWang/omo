package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadMigratesLegacyAPIKey(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"provider":"openai-compatible","baseUrl":"http://localhost:1234/v1","model":"local"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "api-key"), []byte("legacy-key"), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Credential("openai-compatible"); got != "legacy-key" {
		t.Fatalf("migrated credential = %q", got)
	}
}

func TestSavePersistsCredentialsPerProvider(t *testing.T) {
	dir := t.TempDir()
	cfg, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Settings.Provider = "deepseek"
	cfg.Settings.Model = "deepseek-flash"
	cfg.SetCredential("deepseek", "test-key")
	if err := cfg.Save(); err != nil {
		t.Fatal(err)
	}

	reloaded, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Credential("deepseek"); got != "test-key" {
		t.Fatalf("credential = %q", got)
	}
	if !reloaded.Ready() {
		t.Fatal("configuration should be ready")
	}
	if _, err := os.Stat(filepath.Join(dir, "credentials.json")); err != nil {
		t.Fatalf("credentials.json: %v", err)
	}
}

func TestCustomProviderDoesNotRequireCredential(t *testing.T) {
	cfg, err := Load(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg.Settings.Provider = "openai-compatible"
	cfg.Settings.BaseURL = "http://127.0.0.1:8080/v1"
	cfg.Settings.Model = "local-model"
	if !cfg.Ready() {
		t.Fatal("custom provider should be ready without an API key")
	}
}
