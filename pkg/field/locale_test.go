package field

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/QinYangWang/omo/pkg/theme"
)

func TestDatePickerSpeaksChinese(t *testing.T) {
	var v time.Time
	tt := ui.NewTester(func(c *ui.Context) {
		theme.Apply(c)
		ui.Column(c).Padding(20).Children(func() { DatePicker(c, &v, DatePickerProps{}) })
	}, 400, 200)
	tt.SetLocale("zh-Hans")
	tt.Frame()
	if !tt.HasText("选择日期") {
		t.Errorf("no 选择日期 in %q", tt.Texts())
	}
}

func TestCalendarSpeaksChinese(t *testing.T) {
	v := day(2026, time.November, 8)
	tt := calendarTester(&v, CalendarProps{})
	tt.SetLocale("zh-Hans")
	tt.Frame()
	for _, s := range []string{"2026年", "11月", "日", "六", "今天"} {
		if !tt.HasText(s) {
			t.Errorf("no %q in %q", s, tt.Texts())
		}
	}
	year, _ := tt.Find("2026年")
	month, _ := tt.Find("11月")
	if year.X >= month.X {
		t.Errorf("year %+v after month %+v, want 2026年 11月", year, month)
	}
	if _, ok := tt.AccessByRole(ui.RoleButton, "上个月"); !ok {
		t.Error("no 上个月 button")
	}
}
