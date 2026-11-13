package app

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/QinYangWang/omo/internal/config"
)

func writeSkillFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadSkills(t *testing.T) {
	cfgDir := t.TempDir()
	cfg, err := config.Load(cfgDir)
	if err != nil {
		t.Fatal(err)
	}
	workspace := t.TempDir()
	app := &App{Config: cfg}

	writeSkillFile(t, filepath.Join(cfgDir, "skills", "pdf", "SKILL.md"),
		"---\nname: pdf\ndescription: Work with PDF files\n---\n# PDF\nuser scope.\n")
	writeSkillFile(t, filepath.Join(workspace, ".omo", "skills", "deploy", "SKILL.md"),
		"---\nname: deploy\ndescription: Ship the app\n---\n# Deploy\n")
	// Same name as the user skill: the user copy wins.
	writeSkillFile(t, filepath.Join(workspace, ".pi", "skills", "pdf", "SKILL.md"),
		"---\nname: pdf\ndescription: project copy\n---\n# Project PDF\n")
	// No description: skipped.
	writeSkillFile(t, filepath.Join(workspace, ".omo", "skills", "broken", "SKILL.md"), "# no frontmatter\n")
	// A skill root is not searched further.
	writeSkillFile(t, filepath.Join(workspace, ".omo", "skills", "outer", "SKILL.md"),
		"---\nname: outer\ndescription: Outer skill\n---\n# Outer\n")
	writeSkillFile(t, filepath.Join(workspace, ".omo", "skills", "outer", "inner", "SKILL.md"),
		"---\nname: inner\ndescription: Nested skill\n---\n# Inner\n")

	skills := app.loadSkills(workspace)
	// broken has no description and inner sits below a skill root.
	if len(skills) != 3 {
		t.Fatalf("got %d skills, want 3: %+v", len(skills), skills)
	}
	if skills[0].Name != "deploy" || skills[1].Name != "outer" || skills[2].Name != "pdf" {
		t.Fatalf("skills not sorted by name: %+v", skills)
	}
	if skills[2].Description != "Work with PDF files" {
		t.Fatalf("user skill should win the name collision, got %q", skills[2].Description)
	}
	if skills[2].Content == "" || skills[2].Path == "" {
		t.Fatalf("skill content and path should be loaded: %+v", skills[2])
	}
}

func TestParseSkillFrontmatter(t *testing.T) {
	name, description := parseSkillFrontmatter("---\r\nname: \"ci\"\r\ndescription: 'Run CI'\r\n---\r\n# body\r\n")
	if name != "ci" || description != "Run CI" {
		t.Fatalf("got name=%q description=%q", name, description)
	}
	if name, description := parseSkillFrontmatter("# plain markdown\n"); name != "" || description != "" {
		t.Fatalf("plain markdown should have no frontmatter, got %q/%q", name, description)
	}
}
