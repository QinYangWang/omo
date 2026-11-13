package display

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestClosableTagSpeaksChinese(t *testing.T) {
	h := newTagHarness(t, TagProps{Closable: true})
	h.tt.SetLocale("zh-Hans")
	h.tt.Frame()
	if _, ok := h.tt.AccessByRole(ui.RoleButton, "关闭"); !ok {
		t.Errorf("no 关闭 button in %+v", h.tt.AccessAll())
	}
}
