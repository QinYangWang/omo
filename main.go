// Command omo is a native Go AI coding IDE with ACP agent support.
//
// The UI, workspace and ACP client are assembled here; their implementations
// stay behind internal packages. See docs/roadmap.md and docs/architecture.md.
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
	// A known ACP agent on PATH shows up in Agents… without being typed in.
	a.DetectAgents()
	// Puts back the last workspace, its open files and the agent sessions it
	// used. A missing or unreadable database only costs that history.
	if err := a.Restore(); err != nil {
		log.Print(err)
	}

	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:     "omo",
			Width:     1280,
			Height:    800,
			MinWidth:  720,
			MinHeight: 480,
			// The view draws the title bar, its menu and the window's own
			// controls' room (Context.TitleBar), so the chrome is one piece.
			TitleBarStyle:  mygo.TitleBarHidden,
			TitleBarHeight: 38,
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
