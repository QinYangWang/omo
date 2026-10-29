// Command omo is a native Go AI coding IDE with ACP agent support.
//
// P0 scope: real native layout, command routing and a startup benchmark.
// See docs/roadmap.md for the phases and docs/architecture.md for the design.
package main

import (
	"log"

	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/view"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func main() {
	a := app.New()

	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:     "omo",
			Width:     1280,
			Height:    800,
			MinWidth:  720,
			MinHeight: 480,
			// Reopens where the user left it.
			StateKey: "main",
			// Content shows the interface MyGo draws itself; there is no web
			// view anywhere in this app.
			Content: ui.View(func(c *ui.Context) { view.Shell(c, a) }),
		})
		// Background work (file watch events, terminal exit) reaches the main
		// thread through the window.
		a.Attach(win)
		mygo.App.SetMenu(a.Menu())
		a.CaptureIfRequested(win)
	})
	mygo.App.OnQuit(a.Shutdown)

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
