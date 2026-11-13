package moejsruntime

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"
)

// The bundle must load, register every export the Go side calls, and answer
// the pi-ai catalog with the custom OpenAI-compatible provider. No network or
// credential is involved.
func TestBundleLoadsAndListsCatalog(t *testing.T) {
	engine, err := New(nil)
	if err != nil {
		t.Fatalf("load bundle: %v", err)
	}
	defer engine.Close()

	catalog, err := engine.ListCatalog([]CustomProvider{{ID: "openai-compatible", Name: "OpenAI-compatible", BaseURL: "https://api.deepseek.com/v1", Models: []string{"deepseek-chat", "deepseek-reasoner"}}})
	if err != nil {
		t.Fatalf("list catalog: %v", err)
	}
	var custom *CatalogProvider
	builtin := 0
	for i := range catalog.Providers {
		if catalog.Providers[i].ID == "openai-compatible" {
			custom = &catalog.Providers[i]
			continue
		}
		builtin++
	}
	if custom == nil {
		t.Fatal("no openai-compatible provider in the catalog")
	}
	if len(custom.Models) != 2 {
		t.Fatalf("expected both custom models, got %+v", custom.Models)
	}
	for _, model := range custom.Models {
		if model.ID == "deepseek-chat" {
			if model.ContextWindow != 65_536 || model.MaxTokens != 8_192 {
				t.Fatalf("deepseek defaults not applied: %+v", model)
			}
		}
		if model.ID == "deepseek-reasoner" && !model.Reasoning {
			t.Fatalf("deepseek-reasoner should be a reasoning model: %+v", model)
		}
	}
	if builtin == 0 {
		t.Fatal("pi-ai builtin providers are missing")
	}
}

// Opening a session exercises the bundled runtime for real: SQLite storage,
// the harness, the installed extensions, and one conversation per Bot. No
// model request is made.
func TestOpenTeamReportsReady(t *testing.T) {
	engine, err := New(nil)
	if err != nil {
		t.Fatalf("load bundle: %v", err)
	}
	defer engine.Close()

	workspace := t.TempDir()
	if err := engine.SetWorkspaceDir(workspace); err != nil {
		t.Fatal(err)
	}
	if err := engine.OpenTeam(TeamConfig{
		DBPath:   filepath.Join(t.TempDir(), "team.db"),
		TeamID:   "test",
		Provider: "openai-compatible",
		Model:    "deepseek-chat",
		CustomProviders: []CustomProvider{{
			ID: "openai-compatible", Name: "OpenAI-compatible",
			BaseURL: "https://api.deepseek.com/v1", Models: []string{"deepseek-chat"},
		}},
		Workspace: workspace,
		Bots:      []TeamBot{{ID: "b1", Name: "Chief"}},
		Skills: []Skill{{
			Name:        "demo",
			Description: "Example skill",
			Path:        filepath.Join(workspace, "skills", "demo", "SKILL.md"),
			Content:     "---\nname: demo\ndescription: Example skill\n---\n# Demo\n",
		}},
	}); err != nil {
		t.Fatal(err)
	}

	deadline := time.After(30 * time.Second)
	for {
		select {
		case ev := <-engine.Events():
			if ev.Kind != "team" {
				continue
			}
			var snap struct {
				Ready   bool   `json:"ready"`
				Status  string `json:"status"`
				Failure string `json:"failure"`
			}
			if err := json.Unmarshal([]byte(ev.Message), &snap); err != nil {
				continue
			}
			if snap.Failure != "" {
				t.Fatalf("team failed: %s", snap.Failure)
			}
			if snap.Ready {
				return
			}
		case <-deadline:
			t.Fatal("team did not become ready")
		}
	}
}
