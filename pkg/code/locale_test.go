package code

import "testing"

func TestQRCodeSpeaksChinese(t *testing.T) {
	tt := qrTester("https://lobehub.com", QRCodeProps{Status: QRExpired, OnRefresh: func() {}}, nil)
	tt.SetLocale("zh-Hans")
	tt.Frame()
	for _, s := range []string{"已过期", "刷新"} {
		if !tt.HasText(s) {
			t.Errorf("no %q in %q", s, tt.Texts())
		}
	}
}
