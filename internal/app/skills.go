package app

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	moejsruntime "github.com/QinYangWang/omo/internal/runtime/moejs"
)

const (
	maxSkillFileBytes = 64 << 10
	maxSkillDepth     = 4
)

// loadSkills discovers markdown skill packs for the workspace. The user's
// omo config directory wins over project-local skills with the same name, the
// same order pi uses. A directory holding SKILL.md is a skill root and is not
// searched further, so a skill's own files never become skills.
func (a *App) loadSkills(workspace string) []moejsruntime.Skill {
	roots := []string{
		filepath.Join(a.Config.Dir(), "skills"),
		filepath.Join(workspace, ".omo", "skills"),
		filepath.Join(workspace, ".pi", "skills"),
	}
	seen := map[string]bool{}
	var out []moejsruntime.Skill
	for _, root := range roots {
		for _, file := range findSkillFiles(root, 0) {
			skill, err := readSkill(file)
			if err != nil {
				a.Logf("skip skill %s: %v", file, err)
				continue
			}
			if skill.Name == "" || skill.Description == "" || seen[skill.Name] {
				continue
			}
			seen[skill.Name] = true
			out = append(out, skill)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func findSkillFiles(dir string, depth int) []string {
	if depth > maxSkillDepth {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	for _, entry := range entries {
		if !entry.IsDir() && entry.Name() == "SKILL.md" {
			return []string{filepath.Join(dir, entry.Name())}
		}
	}
	var out []string
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		out = append(out, findSkillFiles(filepath.Join(dir, entry.Name()), depth+1)...)
	}
	return out
}

// readSkill reads one SKILL.md: its YAML frontmatter name and description,
// and the whole file as the instructions the model loads on demand.
func readSkill(path string) (moejsruntime.Skill, error) {
	var skill moejsruntime.Skill
	info, err := os.Stat(path)
	if err != nil {
		return skill, err
	}
	if info.Size() > maxSkillFileBytes {
		return skill, fmt.Errorf("%s is larger than %d bytes", path, maxSkillFileBytes)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return skill, err
	}
	content := string(data)
	skill.Path = path
	skill.Content = content
	skill.Name, skill.Description = parseSkillFrontmatter(content)
	if skill.Name == "" {
		skill.Name = filepath.Base(filepath.Dir(path))
	}
	return skill, nil
}

// parseSkillFrontmatter reads the flat `key: value` frontmatter of a skill
// file. Anything missing stays empty; the caller decides whether to skip it.
func parseSkillFrontmatter(content string) (name, description string) {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return "", ""
	}
	for _, line := range lines[1:] {
		trimmed := strings.TrimSpace(line)
		if trimmed == "---" {
			break
		}
		key, value, ok := strings.Cut(trimmed, ":")
		if !ok {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		switch strings.TrimSpace(key) {
		case "name":
			name = value
		case "description":
			description = value
		}
	}
	return name, description
}
