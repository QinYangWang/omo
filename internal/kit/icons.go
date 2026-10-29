package kit

import (
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo/ui"
)

// The design system's icons are Lucide's outlines (ISC license), drawn in the
// color of the text, so they follow the theme. Parsing is tolerant: a broken
// icon must not stop the app from starting, it just draws nothing.
func lucide(body string) *ui.SVG {
	return parseIcon(body, `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`+body+`</svg>`)
}

var (
	IconLogo         = lucide(`<rect x="3" y="3" width="18" height="18" rx="5"/><path d="m8 9 3 3-3 3"/><path d="M13 15h3"/>`)
	IconFiles        = lucide(`<path d="M20 7h-3a2 2 0 0 1-2-2V2"/><path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2Z"/><path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8"/>`)
	IconSearch       = lucide(`<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`)
	IconGit          = lucide(`<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>`)
	IconChevronRight = lucide(`<path d="m9 18 6-6-6-6"/>`)
	IconChevronDown  = lucide(`<path d="m6 9 6 6 6-6"/>`)
	IconTerminal     = lucide(`<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>`)
	IconFolder       = lucide(`<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`)
	IconFolderOpen   = lucide(`<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>`)
	IconFile         = lucide(`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>`)
	IconFileCode     = lucide(`<path d="M10 12.5 8 15l2 2.5"/><path d="m14 12.5 2 2.5-2 2.5"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>`)
	IconFileText     = lucide(`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>`)
	IconFileJSON     = lucide(`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1"/><path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1"/>`)
	IconPlus         = lucide(`<path d="M5 12h14"/><path d="M12 5v14"/>`)
	IconTrash        = lucide(`<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>`)
	IconChat         = lucide(`<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`)
	IconPanel        = lucide(`<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 15h18"/>`)
	IconProblems     = lucide(`<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`)
	IconOutput       = lucide(`<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>`)
	IconRefresh      = lucide(`<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>`)
	IconDiff         = lucide(`<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>`)
	IconPanelHide    = lucide(`<path d="m6 9 6 6 6-6"/>`)
	IconSidebarLeft  = lucide(`<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>`)
	IconSidebarRight = lucide(`<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>`)
	IconRun          = lucide(`<polygon points="6 3 20 12 6 21 6 3"/>`)
	IconGlobe        = lucide(`<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>`)
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
