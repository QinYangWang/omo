package kit

import (
	"bytes"
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
	// The design draws Lucide at a 1.75 stroke, a little lighter than the
	// set's own 2, so 13–17 DIP icons sit at the weight of 13 DIP text.
	data = bytes.Replace(data, []byte(`stroke-width="2"`), []byte(`stroke-width="1.75"`), 1)
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
	// IconLogo is omo's own mark, not a Lucide icon: the accent square of the
	// word mark.
	IconLogo = lucide(`<rect x="7" y="7" width="10" height="10" rx="3" fill="currentColor" stroke="none"/>`)

	// Lucide names in parentheses; see https://lucide.dev/icons/.
	IconFiles          = mustIcon("files")
	IconSearch         = mustIcon("search")
	IconGit            = mustIcon("git-branch")
	IconChevronRight   = mustIcon("chevron-right")
	IconChevronDown    = mustIcon("chevron-down")
	IconChevronLeft    = mustIcon("chevron-left")
	IconTerminal       = mustIcon("terminal")
	IconTerminalSquare = mustIcon("square-terminal")
	IconFolder         = mustIcon("folder")
	IconFolderOpen     = mustIcon("folder-open")
	IconFile           = mustIcon("file")
	IconFileCode       = mustIcon("file-code")
	IconFileText       = mustIcon("file-text")
	IconFileJSON       = mustIcon("file-braces")
	IconFilePlus       = mustIcon("file-plus")
	IconFileMinus      = mustIcon("file-minus")
	IconFileDiff       = mustIcon("file-diff")
	IconPlus           = mustIcon("plus")
	IconTrash          = mustIcon("trash-2")
	IconChat           = mustIcon("message-square")
	IconRefresh        = mustIcon("refresh-cw")
	IconSidebarLeft    = mustIcon("panel-left")
	IconRun            = mustIcon("play")
	IconGlobe          = mustIcon("globe")
	IconNewSession     = mustIcon("square-pen")
	IconSchedule       = mustIcon("calendar-clock")
	IconSettings       = mustIcon("settings")
	IconSun            = mustIcon("sun")
	IconMoon           = mustIcon("moon")
	IconAt             = mustIcon("at-sign")
	IconArrowUp        = mustIcon("arrow-up")
	IconArrowLeft      = mustIcon("arrow-left")
	IconArrowRight     = mustIcon("arrow-right")
	IconStop           = mustIcon("square")
	IconPlan           = mustIcon("list-checks")
	IconMore           = mustIcon("ellipsis")
	IconPencil         = mustIcon("pencil")
	IconShieldCheck    = mustIcon("shield-check")
	IconShieldAlert    = mustIcon("shield-alert")
	IconCircleCheck    = mustIcon("circle-check")
	IconCircle         = mustIcon("circle")
	IconCircleDot      = mustIcon("circle-dot")
	IconCircleAlert    = mustIcon("circle-alert")
	IconCircleX        = mustIcon("circle-x")
	IconCheck          = mustIcon("check")
	IconCheckCheck     = mustIcon("check-check")
	IconCopy           = mustIcon("copy")
	IconLoader         = mustIcon("loader")
	IconX              = mustIcon("x")
	IconKey            = mustIcon("key-round")
	IconHistory        = mustIcon("history")
	IconUndo           = mustIcon("undo-2")
	IconExternal       = mustIcon("external-link")
	IconCommit         = mustIcon("git-commit-horizontal")
	IconPullRequest    = mustIcon("git-pull-request")
	IconInfo           = mustIcon("info")
	IconSliders        = mustIcon("sliders-horizontal")
	IconPalette        = mustIcon("palette")
	IconKeyboard       = mustIcon("keyboard")
	IconBot            = mustIcon("bot")
	IconUser           = mustIcon("user")
	IconBrain          = mustIcon("brain")
	IconPlug           = mustIcon("plug")
	IconHash           = mustIcon("hash")
	IconShare          = mustIcon("share-2")
	IconChart          = mustIcon("chart-column")
	IconEye            = mustIcon("eye")
	IconPi             = mustIcon("pi")
	IconCornerDownLeft = mustIcon("corner-down-left")
	IconMinus          = mustIcon("minus")
	IconPanelRight     = mustIcon("panel-right")
	IconPause          = mustIcon("pause")
	IconLock           = mustIcon("lock")
	IconSparkle        = mustIcon("sparkle")
	IconTriangleAlert  = mustIcon("triangle-alert")
)

func parseIcon(name, svg string) *ui.SVG {
	s, err := ui.ParseSVG([]byte(svg))
	if err != nil {
		slog.Error("kit: icon does not parse", "name", name, "err", err)
		return nil
	}
	return s
}

// FileIcon returns the icon of a file by its name, in the quiet note color.
// The design keeps hue for state only, so a file's color comes from what
// happened to it (StatusColor), never from its language.
func (t Theme) FileIcon(name string) (*ui.SVG, ui.Color) {
	lower := strings.ToLower(name)
	ext := strings.TrimPrefix(filepath.Ext(lower), ".")
	switch lower {
	case "go.mod", "go.sum", "go.work", "makefile", "dockerfile":
		return IconFileCode, t.Text3
	}
	switch ext {
	case "go", "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "rs", "py", "c", "h", "cc", "cpp", "hpp",
		"m", "mm", "java", "kt", "kts", "html", "htm", "vue", "svelte", "css", "scss", "sass", "less", "sh",
		"bash", "zsh", "fish", "ps1":
		return IconFileCode, t.Text3
	case "json", "jsonc", "json5":
		return IconFileJSON, t.Text3
	case "yaml", "yml", "toml", "ini", "conf", "cfg", "xml", "md", "mdx", "markdown", "txt", "rst":
		return IconFileText, t.Text3
	}
	return IconFile, t.Text3
}

// StatusColor is the color of a change letter: added green, deleted red,
// modified amber, untracked quiet.
func (t Theme) StatusColor(status string) ui.Color {
	switch status {
	case "A", "?", "+":
		return t.OK
	case "D", "-":
		return t.Err
	case "M", "R", "U":
		return t.Warn
	}
	return t.Text3
}
