package kit

import (
	"embed"
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo/ui"
)

// The design system's icons are the official Lucide set (ISC license, the
// LICENSE file in icons/), the same files lucide.dev/icons serves. They are
// embedded so the app stays one binary and so a release draws exactly the icons
// it was built with. Refresh them with `./scripts/lucide-icons.sh`, which reads
// the names below; adding an icon is adding a line and running it.
//
//go:embed icons/*.svg
var iconFS embed.FS

// mustIcon parses one embedded Lucide icon. Icons are drawn in the color of the
// text, so they follow the theme. Parsing is tolerant: a broken icon must not
// stop the app from starting, it just draws nothing.
func mustIcon(name string) *ui.SVG {
	data, err := iconFS.ReadFile("icons/" + name + ".svg")
	if err != nil {
		slog.Error("kit: icon is missing", "icon", name, "err", err)
		return nil
	}
	s, err := ui.ParseSVG(data)
	if err != nil {
		slog.Error("kit: icon does not parse", "icon", name, "err", err)
		return nil
	}
	return s
}

// lucide wraps a body in the attributes the whole set shares. Only the app's own
// mark uses it: everything else comes from icons/*.svg.
func lucide(body string) *ui.SVG {
	return parseIcon(body, `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`+body+`</svg>`)
}

var (
	// IconLogo is omo's own mark, not a Lucide icon.
	IconLogo = lucide(`<rect x="3" y="3" width="18" height="18" rx="5"/><path d="m8 9 3 3-3 3"/><path d="M13 15h3"/>`)

	// Lucide names in parentheses; see https://lucide.dev/icons/.
	IconFiles        = mustIcon("files")
	IconSearch       = mustIcon("search")
	IconGit          = mustIcon("git-branch")
	IconChevronRight = mustIcon("chevron-right")
	IconChevronDown  = mustIcon("chevron-down")
	IconTerminal     = mustIcon("terminal")
	IconFolder       = mustIcon("folder")
	IconFolderOpen   = mustIcon("folder-open")
	IconFile         = mustIcon("file")
	IconFileCode     = mustIcon("file-code")
	IconFileText     = mustIcon("file-text")
	IconFileJSON     = mustIcon("file-braces") // Lucide's JSON file icon
	IconPlus         = mustIcon("plus")
	IconTrash        = mustIcon("trash")
	IconChat         = mustIcon("message-square")
	IconPanel        = mustIcon("panel-bottom")
	IconProblems     = mustIcon("triangle-alert")
	IconOutput       = mustIcon("list")
	IconRefresh      = mustIcon("refresh-cw")
	IconDiff         = mustIcon("git-compare")
	IconSidebarLeft  = mustIcon("panel-left")
	IconSidebarRight = mustIcon("panel-right")
	IconRun          = mustIcon("play")
	IconGlobe        = mustIcon("globe")

	// IconPanelHide is the chevron that collapses the bottom panel.
	IconPanelHide = IconChevronDown
)

func parseIcon(name, svg string) *ui.SVG {
	s, err := ui.ParseSVG([]byte(svg))
	if err != nil {
		slog.Error("kit: icon does not parse", "name", name, "err", err)
		return nil
	}
	return s
}

// FileIcon returns the icon and color of a file by its name: code files take
// their language's color, as in the reference editor, and everything else a
// quiet document icon.
func (t Theme) FileIcon(name string) (*ui.SVG, ui.Color) {
	lower := strings.ToLower(name)
	ext := strings.TrimPrefix(filepath.Ext(lower), ".")
	switch lower {
	case "go.mod", "go.sum", "go.work":
		return IconFileCode, t.Lang("#00add8", "#00809f")
	case "package.json", "tsconfig.json":
		return IconFileJSON, t.Lang("#cbcb41", "#9a8a00")
	case "dockerfile", "makefile":
		return IconFileText, t.Lang("#e37933", "#b5571a")
	}
	if strings.HasPrefix(lower, ".") && ext == strings.TrimPrefix(lower, ".") {
		return IconFileText, t.Faint
	}
	switch ext {
	case "go":
		return IconFileCode, t.Lang("#00add8", "#00809f")
	case "ts", "tsx", "mts", "cts":
		return IconFileCode, t.Lang("#4d8fdf", "#2f6fc0")
	case "js", "jsx", "mjs", "cjs":
		return IconFileCode, t.Lang("#e8d44d", "#a68f00")
	case "rs":
		return IconFileCode, t.Lang("#dea584", "#b0643a")
	case "py":
		return IconFileCode, t.Lang("#5a9fd4", "#3572a5")
	case "c", "h", "cc", "cpp", "hpp", "m", "mm":
		return IconFileCode, t.Lang("#7aa6da", "#4a76b0")
	case "java", "kt", "kts":
		return IconFileCode, t.Lang("#e76f51", "#c04a2b")
	case "html", "htm", "vue", "svelte":
		return IconFileCode, t.Lang("#e8714a", "#c4492a")
	case "css", "scss", "sass", "less":
		return IconFileCode, t.Lang("#a074c4", "#7a4fa8")
	case "sh", "bash", "zsh", "fish", "ps1":
		return IconTerminal, t.Lang("#89e051", "#4f9a1f")
	case "json", "jsonc", "json5":
		return IconFileJSON, t.Lang("#cbcb41", "#9a8a00")
	case "yaml", "yml", "toml", "ini", "conf", "cfg", "xml":
		return IconFileText, t.Lang("#c9a0dc", "#8a5aa8")
	case "md", "mdx", "markdown", "txt", "rst":
		return IconFileText, t.Lang("#6ba4d8", "#3d78ad")
	case "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp":
		return IconFileText, t.Lang("#a6c56a", "#5f8a26")
	}
	return IconFile, t.Muted
}
