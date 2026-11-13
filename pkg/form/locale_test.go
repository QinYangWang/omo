package form

import "testing"

func TestFormSpeaksChinese(t *testing.T) {
	h := newHarness(t, Props[profile]{})
	h.tt.SetLocale("zh-Hans")
	h.f.Values.Name = ""
	h.tt.Frame()
	h.click("提交")
	for _, s := range []string{"此项为必填项", "未保存的更改", "重置"} {
		if !h.tt.HasText(s) {
			t.Errorf("no %q in %q", s, h.tt.Texts())
		}
	}
}
