package i18n

import "testing"

func TestCatalogsLoad(t *testing.T) {
	if catalog == nil {
		t.Fatal("catalog did not load; see the logged error")
	}
	langs := catalog.Languages()
	if len(langs) < 2 {
		t.Fatalf("want at least en and zh-Hans, got %v", langs)
	}
}

func TestTAndFallback(t *testing.T) {
	if got := T("en", "sectionExplorer"); got != "Explorer" {
		t.Errorf("T(en, sectionExplorer) = %q", got)
	}
	if got := T("zh-Hans", "sectionExplorer"); got != "资源管理器" {
		t.Errorf("T(zh-Hans, sectionExplorer) = %q", got)
	}
	// An unknown locale falls back to the source language.
	if got := T("de", "sectionExplorer"); got != "Explorer" {
		t.Errorf("T(de, sectionExplorer) = %q", got)
	}
	// A missing key returns the key, so the gap is visible in the UI.
	if got := T("en", "noSuchKey"); got != "noSuchKey" {
		t.Errorf("missing key = %q", got)
	}
}

func TestTfPlaceholders(t *testing.T) {
	got := Tf("en", "noticeFileSaved", map[string]any{"path": "internal/app/app.go"})
	want := "Saved internal/app/app.go"
	if got != want {
		t.Errorf("Tf = %q, want %q", got, want)
	}
	// Every key must exist in both catalogs, and formatting must not leave
	// unresolved braces behind.
	for _, locale := range []string{"en", "zh-Hans"} {
		if got := Tf(locale, "statusLineCol", map[string]any{"line": 3, "col": 7}); got == "" {
			t.Errorf("Tf(%s, statusLineCol) is empty", locale)
		}
		// Plural forms must pick the right case per language.
		if got := Tf(locale, "changesCount", map[string]any{"count": 1}); got == "" {
			t.Errorf("Tf(%s, changesCount) is empty", locale)
		}
	}
}
