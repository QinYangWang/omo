package agent

import (
	"path/filepath"
	"strings"
)

// Preset is a known ACP agent: the executables its package installs, the
// arguments it needs, and the npm package that updates it. Nothing here is
// bundled: a preset only says how to look for an agent the user installed.
type Preset struct {
	ID      string
	Name    string
	Bins    []string // executable names, in order of preference
	Args    []string
	Package string // npm package, "" when the agent does not come from npm
}

// presets are the agents omo looks for on PATH at startup. Each is a third-party
// program that speaks ACP v1 over stdio.
var presets = []Preset{
	{ID: "codex", Name: "Codex", Bins: []string{"codex-acp"}, Package: "@agentclientprotocol/codex-acp"},
	{ID: "claude", Name: "Claude Code", Bins: []string{"claude-code-acp"}, Package: "@zed-industries/claude-code-acp"},
	{ID: "pi", Name: "Pi", Bins: []string{"pi-acp"}, Package: "pi-acp"},
}

// Presets returns the known agents, in the order the app looks for them.
func Presets() []Preset {
	out := make([]Preset, len(presets))
	for i, p := range presets {
		p.Bins = append([]string(nil), p.Bins...)
		p.Args = append([]string(nil), p.Args...)
		out[i] = p
	}
	return out
}

// PresetFor returns the preset that launches executable, matched by its file
// name without the extension npm adds on Windows (.cmd). A user-given path to
// a known adapter still finds its preset, and so its update command.
func PresetFor(executable string) (Preset, bool) {
	base := filepath.Base(executable)
	base = strings.TrimSuffix(base, filepath.Ext(base))
	for _, p := range presets {
		for _, bin := range p.Bins {
			if strings.EqualFold(base, bin) {
				return p, true
			}
		}
	}
	return Preset{}, false
}
