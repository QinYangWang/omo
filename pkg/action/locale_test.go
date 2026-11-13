package action

import (
	"testing"

	"github.com/egoist/mygo/ui"
	"github.com/QinYangWang/omo/pkg/internal/testkit"
)

func TestCopyButtonSpeaksChinese(t *testing.T) {
	tt := ui.NewTester(testkit.Centered(func(c *ui.Context) { CopyButton(c, "x", CopyButtonProps{}) }), 300, 100)
	tt.SetLocale("zh-Hans")
	tt.Frame()
	if _, ok := tt.AccessByRole(ui.RoleButton, "复制"); !ok {
		t.Errorf("no 复制 button in %+v", tt.AccessAll())
	}
}
