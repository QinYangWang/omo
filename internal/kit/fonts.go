package kit

import (
	"embed"
	"sync"

	"github.com/egoist/mygo/ui"
)

// The interface is set in Geist and code, paths and numbers in Geist Mono, both
// SIL Open Font License 1.1 (fonts/OFL.txt). They are embedded so every
// platform draws the same Latin text; Chinese falls back to the system's CJK
// face, which the design's stack names next (Noto Sans SC, PingFang SC,
// Microsoft YaHei UI). Bundling a CJK face would add 8–16 MB per weight.
//
//go:embed fonts/*.ttf
var fontFS embed.FS

var fontFiles = []struct{ file, family string }{
	{"Geist-Regular.ttf", FontSans},
	{"Geist-Medium.ttf", FontSans},
	{"Geist-SemiBold.ttf", FontSans},
	{"Geist-Bold.ttf", FontSans},
	{"GeistMono-Regular.ttf", FontMono},
	{"GeistMono-Medium.ttf", FontMono},
	{"GeistMono-SemiBold.ttf", FontMono},
}

var registerOnce sync.Once

// RegisterFonts adds the embedded families. Call it once before the first
// window; later calls do nothing. A font that does not load is skipped: the
// window then draws that text in the system face, which is a look problem,
// not a reason to fail to start.
func RegisterFonts() error {
	var first error
	registerOnce.Do(func() {
		for _, f := range fontFiles {
			data, err := fontFS.ReadFile("fonts/" + f.file)
			if err == nil {
				err = ui.RegisterFont(data, f.family)
			}
			if err != nil && first == nil {
				first = err
			}
		}
	})
	return first
}
