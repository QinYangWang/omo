package ui

import (
	"testing"

	mygoui "github.com/egoist/mygo/ui"

	"github.com/QinYangWang/omo/internal/app"
	"github.com/QinYangWang/omo/internal/config"
)

// TestBuildRendersChat covers the empty prompt, the transcript and the
// composer, where a panic would leave a real window blank.
func TestBuildRendersChat(t *testing.T) {
	newApp := func() *app.App {
		cfg := &config.Config{Settings: config.Defaults()}
		return &app.App{Config: cfg, Status: "idle", Input: "hello"}
	}

	t.Run("empty", func(t *testing.T) {
		tt := mygoui.NewTester((&view{app: newApp()}).build, 900, 620)
		for _, want := range []string{"How can I help you today?", "New chat", "Settings"} {
			if !tt.HasText(want) {
				t.Errorf("missing %q in %q", want, tt.Texts())
			}
		}
	})

	t.Run("transcript", func(t *testing.T) {
		a := newApp()
		a.Messages = []app.Message{
			{Role: "user", Text: "Group the sidebar by workspace."},
			{Role: "assistant", Text: "## Plan\n\n1. Group chats.\n\n```go\nx := 1\n```\n\nDone."},
		}
		tt := mygoui.NewTester((&view{app: a}).build, 900, 620)
		for _, want := range []string{"Group the sidebar by workspace.", "Group chats."} {
			if !tt.HasText(want) {
				t.Errorf("missing %q in %q", want, tt.Texts())
			}
		}
	})
}
