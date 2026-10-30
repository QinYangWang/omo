package app

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/QinYangWang/omo/internal/agent"
)

// fakeCLI puts an executable named name on PATH, ahead of anything installed,
// and returns its path.
func fakeCLI(t *testing.T, name string) string {
	t.Helper()
	dir := t.TempDir()
	if runtime.GOOS == "windows" {
		name += ".cmd" // LookPath needs a PATHEXT extension here
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return path
}

// newDetectApp is an app with its own config directory and no catalog yet.
func newDetectApp(t *testing.T) *App {
	t.Helper()
	t.Setenv("OMO_CONFIG_DIR", t.TempDir())
	a := New()
	t.Cleanup(a.Shutdown)
	return a
}

// matching returns the definitions that launch the same adapter as path.
func matching(a *App, path string) []agent.Definition {
	var out []agent.Definition
	for _, def := range a.AgentDefinitions() {
		if resolved, err := filepath.Abs(def.Executable); err == nil && resolved == path {
			out = append(out, def)
		}
	}
	return out
}

func TestDetectAgentsFindsInstalledCLI(t *testing.T) {
	path := fakeCLI(t, "codex-acp")
	a := newDetectApp(t)
	a.DetectAgents()

	def, ok := a.agentDefinition("codex")
	if !ok {
		t.Fatalf("detected agents = %+v", a.AgentDefinitions())
	}
	if def.Trusted || def.Name != "Codex" || len(matching(a, path)) != 1 {
		t.Fatalf("definition = %+v", def)
	}
	// The first agent found is the one the chat panel shows.
	if a.ActiveAgentID() != "codex" {
		t.Fatalf("active agent = %q", a.ActiveAgentID())
	}
	// Running it again must not duplicate or re-trust anything.
	a.DetectAgents()
	if n := len(matching(a, path)); n != 1 {
		t.Fatalf("entries for one adapter = %d, want 1", n)
	}
}

func TestDetectAgentsLeavesConfiguredAgentAlone(t *testing.T) {
	path := fakeCLI(t, "codex-acp")
	a := newDetectApp(t)
	a.agentConfig = AgentConfigDraft{Open: true, Name: "My Codex", Executable: path}
	a.Dispatch(SaveAgentConfig{})
	configured := a.ActiveAgentID()

	a.DetectAgents()
	defs := matching(a, path)
	if len(defs) != 1 || defs[0].ID != configured || defs[0].Name != "My Codex" {
		t.Fatalf("configured agent was not kept alone: %+v", a.AgentDefinitions())
	}
}

func TestAgentUpdatableOnlyForKnownPackages(t *testing.T) {
	fakeCLI(t, "codex-acp")
	a := newDetectApp(t)
	a.DetectAgents()
	if !a.AgentUpdatable("codex") {
		t.Fatal("codex should be updatable")
	}
	a.agentConfig = AgentConfigDraft{Open: true, Name: "Test", Executable: os.Args[0]}
	a.Dispatch(SaveAgentConfig{})
	for _, def := range a.AgentDefinitions() {
		if def.Name == "Test" && a.AgentUpdatable(def.ID) {
			t.Fatal("an arbitrary executable should have no update command")
		}
	}
}
