package choice

import (
	"testing"

	"github.com/egoist/mygo/ui"
	"github.com/QinYangWang/omo/pkg/theme"
)

func TestColorSwatchesSpeakChinese(t *testing.T) {
	v := ui.Hex("#f5222d")
	tt := ui.NewTester(func(c *ui.Context) {
		theme.Apply(c)
		ui.Column(c).Padding(20).Children(func() {
			ColorSwatches(c, &v, ColorSwatchesProps{Colors: []ColorSwatch{{Color: v, Title: "Red"}}, EnableColorPicker: true})
		})
	}, 300, 100)
	tt.SetLocale("zh-Hans")
	tt.Frame()
	if _, ok := tt.AccessByRole(ui.RoleButton, "自定义颜色"); !ok {
		t.Errorf("no 自定义颜色 button in %+v", tt.AccessAll())
	}
}
