package l10n

import (
	"encoding/json"
	"testing"

	"github.com/egoist/mygo/ui"
)

func say(locale, key string) string {
	var got string
	tt := ui.NewTester(func(c *ui.Context) { got = Text(c, key) }, 100, 100)
	if locale != "" {
		tt.SetLocale(locale)
	}
	tt.Frame()
	return got
}

func TestTextSpeaksTheWindowsLanguage(t *testing.T) {
	for _, tc := range []struct{ locale, want string }{
		{"", "Close"},
		{"en", "Close"},
		{"zh-Hans", "关闭"},
		{"zh-CN", "关闭"},
		{"de", "Close"},
	} {
		if got := say(tc.locale, "close"); got != tc.want {
			t.Errorf("close in %q = %q, want %q", tc.locale, got, tc.want)
		}
	}
}

func TestEveryKeyIsTranslated(t *testing.T) {
	en, zh := keys(t, "en"), keys(t, "zh-Hans")
	for k := range en {
		if !zh[k] {
			t.Errorf("zh-Hans lacks %q", k)
		}
	}
	for k := range zh {
		if !en[k] {
			t.Errorf("zh-Hans has %q, which en.json does not", k)
		}
	}
}

func keys(t *testing.T, lang string) map[string]bool {
	t.Helper()
	b, err := messages.ReadFile("messages/" + lang + ".json")
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for k := range m {
		if k[0] != '@' {
			out[k] = true
		}
	}
	return out
}
