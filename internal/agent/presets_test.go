package agent

import "testing"

func TestPresetForMatchesInstalledNames(t *testing.T) {
	cases := map[string]string{
		"codex-acp":                             "codex",
		"codex-acp.exe":                         "codex",
		`C:\Users\me\AppData\npm\codex-acp.cmd`: "codex",
		"/usr/local/bin/claude-code-acp":        "claude",
		"pi-acp":                                "pi",
	}
	for executable, want := range cases {
		preset, ok := PresetFor(executable)
		if !ok || preset.ID != want {
			t.Errorf("PresetFor(%q) = %q, %v; want %q", executable, preset.ID, ok, want)
		}
	}
	if _, ok := PresetFor("/usr/local/bin/some-other-agent"); ok {
		t.Error("unknown executable matched a preset")
	}
}

func TestPresetsAreLaunchers(t *testing.T) {
	for _, p := range Presets() {
		if p.ID == "" || p.Name == "" || len(p.Bins) == 0 || p.Bins[0] == "" {
			t.Errorf("preset %+v is incomplete", p)
		}
		if p.Package == "" {
			t.Errorf("preset %q has no update package", p.ID)
		}
	}
	if len(Presets()) == 0 {
		t.Fatal("no presets")
	}
}
