package layout

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestDraggablePanelSpeaksChinese(t *testing.T) {
	size, expanded := float32(280), true
	tt := panelTester(&size, &expanded, DraggablePanelProps{})
	tt.SetLocale("zh-Hans")
	tt.Frame()
	if _, ok := tt.AccessByRole(ui.RoleSeparator, "调整面板大小"); !ok {
		t.Errorf("no 调整面板大小 separator in %+v", tt.AccessAll())
	}
}
