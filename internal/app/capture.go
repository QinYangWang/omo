package app

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

// Screenshot mode lets a developer look at the UI without clicking through it.
// It is off unless OMO_SCREENSHOT names an output PNG.
//
//	OMO_SCREENSHOT=ui.png \
//	OMO_SCREENSHOT_WORKSPACE=$PWD \
//	OMO_SCREENSHOT_OPEN=main.go,internal/view/shell.go \
//	OMO_SCREENSHOT_TERMINAL=1 \
//	./build/omo
//
// The window opens, the app applies the requested state, the PNG is written, and
// the app exits. See docs/benchmarks.md for the companion benchmark mode.
const (
	screenshotEnv       = "OMO_SCREENSHOT"
	screenshotWorkspace = "OMO_SCREENSHOT_WORKSPACE"
	screenshotOpen      = "OMO_SCREENSHOT_OPEN"
	screenshotTerminal  = "OMO_SCREENSHOT_TERMINAL"
	screenshotDiff      = "OMO_SCREENSHOT_DIFF"
	screenshotDelayMS   = "OMO_SCREENSHOT_MS"
)

// CaptureIfRequested starts the screenshot run for a freshly created window.
//
// It is exported so main can call it, and does nothing unless the environment
// asks for a screenshot.
func (a *App) CaptureIfRequested(win *mygo.Window) {
	path := os.Getenv(screenshotEnv)
	if path == "" {
		return
	}
	if dir := os.Getenv(screenshotWorkspace); dir != "" {
		a.Dispatch(OpenWorkspace{Path: dir})
	}
	for _, rel := range strings.Split(os.Getenv(screenshotOpen), ",") {
		if rel = strings.TrimSpace(rel); rel != "" {
			a.Dispatch(OpenFile{Path: rel})
		}
	}
	if rel := os.Getenv(screenshotDiff); rel != "" {
		a.Dispatch(OpenDiff{Path: rel})
	}
	if os.Getenv(screenshotTerminal) != "" {
		a.Dispatch(NewTerminal{})
	}

	delay := 1200 * time.Millisecond
	if ms := os.Getenv(screenshotDelayMS); ms != "" {
		var n int
		if _, err := fmt.Sscanf(ms, "%d", &n); err == nil && n > 0 {
			delay = time.Duration(n) * time.Millisecond
		}
	}
	go func() {
		// Let the first frames (and a terminal's shell prompt) land.
		time.Sleep(delay)
		png, err := win.CapturePage()
		if err == nil {
			err = os.WriteFile(path, png, 0o644)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "screenshot: %v\n", err)
		}
		mygo.App.Exit(0)
	}()
}
