package nav

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestPaginationSpeaksChinese(t *testing.T) {
	cur := 10
	tt := pagerTester(&cur, PaginationProps{Total: 500})
	tt.SetLocale("zh-Hans")
	tt.Frame()
	for _, name := range []string{"上一页", "下一页", "向后 5 页", "向前 5 页"} {
		if _, ok := tt.AccessByRole(ui.RoleButton, name); !ok {
			t.Errorf("no %q button", name)
		}
	}
}
