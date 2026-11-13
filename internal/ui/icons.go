package ui

import mygoui "github.com/egoist/mygo/ui"

// icon parses a 24px stroke icon drawn in the color of the text.
func icon(body string) *mygoui.SVG {
	return mygoui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">` + body + `</svg>`))
}

var (
	iconPlus         = icon(`<path d="M12 5v14M5 12h14"/>`)
	iconGrid         = icon(`<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>`)
	iconSliders      = icon(`<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>`)
	iconArrowUp      = icon(`<path d="M12 19V5M6 11l6-6 6 6"/>`)
	iconArrowLeft    = icon(`<path d="M19 12H5M11 18l-6-6 6-6"/>`)
	iconStop         = icon(`<rect x="7.5" y="7.5" width="9" height="9" rx="2" fill="currentColor" stroke="none"/>`)
	iconPanelRight   = icon(`<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>`)
	iconPanelClose   = icon(`<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/><path d="m8 9 3 3-3 3"/>`)
	iconCompose      = icon(`<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z"/>`)
	iconLayers       = icon(`<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>`)
	iconFolder       = icon(`<path d="M3.5 7.5a2 2 0 0 1 2-2h3.4l2 2h7.6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>`)
	iconChat         = icon(`<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1.1L3 20l1.1-5.3A8.5 8.5 0 1 1 21 11.5z"/>`)
	iconChevron      = icon(`<path d="M6 9l6 6 6-6"/>`)
	iconChevronRight = icon(`<path d="M9 6l6 6-6 6"/>`)
	iconCheck        = icon(`<path d="M20 6L9 17l-5-5"/>`)
	iconFile         = icon(`<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>`)
	iconX            = icon(`<path d="M18 6L6 18M6 6l12 12"/>`)
)
