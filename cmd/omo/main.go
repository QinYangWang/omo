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
	"github.com/QinYangWang/omo/internal/chat"
	"github.com/QinYangWang/omo/internal/config"
	moejsruntime "github.com/QinYangWang/omo/internal/runtime/moejs"
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
	store, err := chat.Open(dir)
	if err != nil {
		log.Fatalf("open chat store: %v", err)
	}
	defer store.Close()

	engine, err := moejsruntime.New(func(format string, args ...any) {
		log.Printf(format, args...)
	})
	if err != nil {
		log.Fatalf("start pi-durable runtime: %v", err)
	}

	a := app.New(cfg, store, engine)
	a.Start()

	mygo.App.SetName("omo")

	mygo.App.WhenReady(func() {
		// Dark by preference; the UI uses theme tokens, so it still reads
		// correctly if the user's system overrides nothing.
		mygo.Theme.SetSource(mygo.ThemeDark)

		win := mygo.NewWindow(mygo.WindowOptions{
			Title:     "omo",
			Width:     1100,
			Height:    760,
			MinWidth:  900,
			MinHeight: 560,
			Content:   ui.Content(a),
		})
		a.Attach(win)

		if cfg.Settings.Workspace != "" {
			a.Update(func() {
				if err := a.SetWorkspace(cfg.Settings.Workspace); err != nil {
					log.Printf("workspace %s is unavailable: %v", cfg.Settings.Workspace, err)
					return
				}
				// Reopen the most recent conversation, as desktop chat apps do.
				if sessions, err := store.ListSessions(1); err == nil && len(sessions) > 0 {
					a.OpenSession(sessions[0].ID)
				}
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
