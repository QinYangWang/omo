package app

import (
	"fmt"
	"os"
	"time"

	"github.com/egoist/mygo"
)

// benchStartupEnv turns on the startup benchmark: the first view build counts as
// "first usable frame", which is printed and then the app exits. scripts/bench
// uses it; normal runs never take this path.
const benchStartupEnv = "OMO_BENCH_STARTUP"

func benchEnabled() bool { return os.Getenv(benchStartupEnv) != "" }

// NoteFrame is called by the view at the start of every frame. Only benchmark
// mode records anything, so a normal run pays one boolean check.
//
// It measures from the start of main() to the first completed view build, which
// is what a user experiences as startup, not a frame rate.
func (a *App) NoteFrame() {
	if !a.bench || a.firstFrame > 0 {
		return
	}
	a.firstFrame = time.Since(a.startedAt)
	// Print now rather than on quit: the quit path races process teardown, and a
	// benchmark must not depend on it.
	fmt.Printf("bench first_frame_ms=%.1f\n", float64(a.firstFrame.Microseconds())/1000)
	// Let that frame reach the screen, then quit. The measurement is already
	// taken and does not depend on this wait.
	go func() {
		time.Sleep(100 * time.Millisecond)
		mygo.App.Exit(0)
	}()
}
