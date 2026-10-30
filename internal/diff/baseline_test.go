package diff

import "testing"

func TestBaselineKeepsTheFirstCaptureOfAPath(t *testing.T) {
	b := NewBaseline()
	if !b.Capture("a.go", "one\n", false) {
		t.Fatal("first capture refused")
	}
	if !b.Capture("a.go", "two\n", false) {
		t.Fatal("second capture of a known path reported a failure")
	}
	if entries := b.Entries(); len(entries) != 1 || entries[0].Text != "one\n" {
		t.Fatalf("entries = %+v", entries)
	}
	if !b.Has("a.go") || b.Has("b.go") {
		t.Error("Has disagrees with the captures")
	}
}

func TestBaselineOrderAndNewFile(t *testing.T) {
	b := NewBaseline()
	b.Capture("b.go", "b\n", false)
	b.Capture("a.go", "", true)
	entries := b.Entries()
	if len(entries) != 2 || entries[0].Rel != "b.go" || entries[1].Rel != "a.go" || !entries[1].NewFile {
		t.Fatalf("entries = %+v", entries)
	}
}

func TestBaselineDegradesOverBudget(t *testing.T) {
	b := NewBaselineLimit(8)
	if !b.Capture("a.go", "12345678", false) {
		t.Fatal("capture within budget refused")
	}
	if b.Capture("b.go", "1", false) {
		t.Fatal("capture past the budget accepted")
	}
	if !b.Degraded() {
		t.Error("Degraded = false after a refused capture")
	}
	if b.Bytes() != 8 {
		t.Errorf("bytes = %d, want 8", b.Bytes())
	}
	if b.Has("b.go") {
		t.Error("a refused file was recorded")
	}
}

func TestBaselineCapsFileCount(t *testing.T) {
	b := NewBaseline()
	for i := 0; i < maxBaselineFiles; i++ {
		if !b.Capture(string(rune('a'+i%26))+string(rune(i)), "", false) {
			t.Fatalf("capture %d refused", i)
		}
	}
	if b.Capture("one-more", "", false) {
		t.Fatal("capture past the file count accepted")
	}
	if !b.Degraded() {
		t.Error("Degraded = false after the file count cap")
	}
}

func TestNilBaselineIsEmpty(t *testing.T) {
	var b *Baseline
	if b.Entries() != nil || b.Bytes() != 0 || b.Degraded() || b.Has("a") {
		t.Error("a nil baseline reported content")
	}
}
