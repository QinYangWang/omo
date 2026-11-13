package ui

import (
	"testing"

	mygoui "github.com/egoist/mygo/ui"
)

type stubHost struct {
	actions []string
	failed  error
}

func (h *stubHost) Value(string) any { return "" }
func (h *stubHost) Perform(action, arg string) error {
	h.actions = append(h.actions, action+"|"+arg)
	return nil
}
func (h *stubHost) Fail(err error)                     { h.failed = err }
func (h *stubHost) RenderTranscript(c *mygoui.Context) { mygoui.Text(c, "transcript") }
func (h *stubHost) RenderComposer(c *mygoui.Context)   { mygoui.Text(c, "composer") }
func (h *stubHost) RenderSessions(c *mygoui.Context)   { mygoui.Text(c, "sessions") }

// TestRenderKitWidgets covers the widgets that map to kit components: a card,
// a heading, text, an input and a button carrying its action.
func TestRenderKitWidgets(t *testing.T) {
	root := &Node{Type: "page", Padding: 12, Gap: 8, Children: []Node{
		{Type: "card", Children: []Node{
			{Type: "heading", Text: "Team"},
			{Type: "text", Text: "Pick a workspace", Wrap: true},
			{Type: "input", Key: "name", Placeholder: "Workspace name"},
			{Type: "button", Text: "Save", Primary: true, Action: "workspace.choose", Arg: "{{ name }}"},
		}},
		{Type: "divider"},
	}}
	host := &stubHost{}
	view := func(c *mygoui.Context) { Render(c, root, NewState(), host) }
	tt := mygoui.NewTester(view, 600, 400)
	for _, want := range []string{"Team", "Pick a workspace", "Save"} {
		if !tt.HasText(want) {
			t.Errorf("missing %q in %q", want, tt.Texts())
		}
	}
	if err := tt.Click("Save"); err != nil {
		t.Fatal(err)
	}
	if len(host.actions) != 1 || host.actions[0] != "workspace.choose|" {
		t.Errorf("actions %v, want the button's action", host.actions)
	}
	if host.failed != nil {
		t.Errorf("render failed: %v", host.failed)
	}
}
