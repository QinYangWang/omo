package feedback

import "testing"

func TestModalSpeaksChinese(t *testing.T) {
	open, oks := true, 0
	tt := modalTester(&open, ModalProps{Title: "Delete files"}, &oks)
	tt.SetLocale("zh-Hans")
	settle(tt)
	for _, s := range []string{"确定", "取消"} {
		if !tt.HasText(s) {
			t.Errorf("no %q in %q", s, tt.Texts())
		}
	}
}
