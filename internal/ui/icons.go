package ui

import mygoui "github.com/egoist/mygo/ui"

// icon parses a 24px stroke icon drawn in the color of the text.
func icon(body string) *mygoui.SVG {
	return mygoui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">` + body + `</svg>`))
}

var (
	iconPlus = icon(`<path d="M12 5v14M5 12h14"/>`)
	iconGrid = icon(`<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>`)
	iconSliders = icon(`<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>`)
	iconFolder = icon(`<path d="M3.5 7.5a2 2 0 0 1 2-2h3.4l2 2h7.6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>`)
	iconArrowUp = icon(`<path d="M12 19V5M6 11l6-6 6 6"/>`)
	iconArrowLeft = icon(`<path d="M19 12H5M11 18l-6-6 6-6"/>`)
	iconStop = icon(`<rect x="7.5" y="7.5" width="9" height="9" rx="2" fill="currentColor" stroke="none"/>`)
	iconChevronDown = icon(`<path d="M6 9l6 6 6-6"/>`)
)
