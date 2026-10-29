package view

import (
	"log/slog"

	"github.com/egoist/mygo/ui"
)

// The activity rail's icons are inline SVGs drawn in the text color, so they
// follow the theme. Parsing is tolerant: a broken icon must not stop the app from
// starting, it just draws nothing.
var (
	iconFiles        = parseIcon("files", `<svg viewBox="0 0 24 24"><rect x="3.5" y="3" width="11" height="15" rx="1.5"/><rect x="9.5" y="6" width="11" height="15" rx="1.5" opacity=".55"/></svg>`)
	iconSearch       = parseIcon("search", `<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="5.6"/><rect x="14.6" y="16.2" width="6" height="2.2" rx="1.1" transform="rotate(45 17.6 17.3)"/></svg>`)
	iconGit          = parseIcon("git", `<svg viewBox="0 0 24 24"><circle cx="7" cy="6" r="2.5"/><circle cx="7" cy="18" r="2.5"/><circle cx="17" cy="12.5" r="2.5"/><rect x="5.9" y="7" width="2.2" height="10"/><rect x="7" y="11.4" width="9" height="2.2"/></svg>`)
	iconChevronRight = parseIcon("chevron-right", `<svg viewBox="0 0 16 16"><path d="M6 3.5l4.5 4.5L6 12.5z"/></svg>`)
	iconChevronDown  = parseIcon("chevron-down", `<svg viewBox="0 0 16 16"><path d="M3.5 6L8 10.5 12.5 6z"/></svg>`)
	iconTerminal     = parseIcon("terminal", `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" opacity=".45"/><path d="M7 9.2l3.4 2.9L7 15z"/><rect x="12" y="13.6" width="5.4" height="1.9" rx=".95"/></svg>`)
)

func parseIcon(name, svg string) *ui.SVG {
	s, err := ui.ParseSVG([]byte(svg))
	if err != nil {
		slog.Error("view: icon does not parse", "icon", name, "err", err)
		return nil
	}
	return s
}
