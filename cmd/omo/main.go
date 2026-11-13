// omo is a native desktop chat app: MyGo draws the window, Go owns
// the process, and the official Pi Durable agent harness runs inside it on
// the pure-Go moejs JavaScript runtime.
package main

import (
	"log"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"

	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/bots"
	"github.com/QinYangWang/omo/internal/config"
	moejsruntime "github.com/QinYangWang/omo/internal/runtime/moejs"
	"github.com/QinYangWang/omo/internal/telemetry"
	"github.com/QinYangWang/omo/internal/ui"
)

func main() {
	log.SetFlags(log.Ltime | log.Lmicroseconds)

	dataDir, err := os.UserConfigDir()
	if err != nil {
		dataDir = "."
	}
	dir := filepath.Join(dataDir, "omo")
	if override := os.Getenv("OMO_DATA"); override != "" {
		dir = override
	} else if legacy := os.Getenv("MYGO_AI_DATA"); legacy != "" {
		dir = legacy
	}

	cfg, err := config.Load(dir)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	roster, err := bots.Open(filepath.Join(dir, "bots"))
	if err != nil {
		log.Fatalf("open bot store: %v", err)
	}
	defer func() { _ = roster.Close() }()
	stats, err := telemetry.Open(dir)
	if err != nil {
		log.Fatalf("open telemetry store: %v", err)
	}
	defer stats.Close()

	engine, err := moejsruntime.New(func(format string, args ...any) {
		log.Printf(format, args...)
	})
	if err != nil {
		log.Fatalf("start pi-durable runtime: %v", err)
	}

	a := app.New(cfg, roster, stats, engine)
	a.Start()

	mygo.App.SetName("omo")

	mygo.App.WhenReady(func() {
		mygo.Theme.SetSource(app.ThemeSource(cfg.Settings.Appearance))

		win := mygo.NewWindow(mygo.WindowOptions{
			Title:           "omo",
			Width:           1100,
			Height:          760,
			MinWidth:        720,
			MinHeight:       480,
			TitleBarStyle:   mygo.TitleBarHidden,
			TitleBarHeight:  44,
			BackgroundColor: app.WindowBackdrop(cfg.Settings.Appearance),
			Content:         ui.Content(a),
		})
		a.Attach(win)

		if cfg.Settings.Workspace != "" {
			a.Update(func() {
				if err := a.SetWorkspace(cfg.Settings.Workspace); err != nil {
					log.Printf("workspace %s is unavailable: %v", cfg.Settings.Workspace, err)
					return
				}
				// Open the team: Chief on first start.
				a.StartNewChat()
			})
		}
	})

	mygo.App.OnWillQuit(func(*mygo.QuitEvent) {
		engine.Close()
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
