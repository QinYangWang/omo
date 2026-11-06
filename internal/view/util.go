package view

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/QinYangWang/omo/internal/i18n"
	"github.com/egoist/mygo/ui"
)

// tr and trf translate with the window's locale.
func tr(c *ui.Context, key string) string { return i18n.T(c.Locale(), key) }

func trf(c *ui.Context, key string, args map[string]any) string {
	return i18n.Tf(c.Locale(), key, args)
}

// baseName is the last element of a slash or backslash path.
func baseName(rel string) string {
	for i := len(rel) - 1; i >= 0; i-- {
		if rel[i] == '/' || rel[i] == '\\' {
			return rel[i+1:]
		}
	}
	return rel
}

// homePath writes a path under the home directory as ~/…, as the design does.
func homePath(p string) string {
	if home, err := os.UserHomeDir(); err == nil && home != "" && strings.HasPrefix(p, home) {
		return "~" + strings.ReplaceAll(p[len(home):], "\\", "/")
	}
	return p
}

// relTime is "刚刚", "2 小时", "昨天" or a date: how long ago something
// happened, as the sidebar shows it.
func relTime(c *ui.Context, t, now time.Time) string {
	if t.IsZero() {
		return ""
	}
	d := now.Sub(t)
	switch {
	case d < time.Minute:
		return tr(c, "timeJustNow")
	case d < time.Hour:
		return trf(c, "timeMinutes", map[string]any{"n": int(d.Minutes())})
	case d < 24*time.Hour:
		return trf(c, "timeHours", map[string]any{"n": int(d.Hours())})
	case d < 48*time.Hour:
		return tr(c, "timeYesterday")
	}
	return trf(c, "timeDate", map[string]any{"month": int(t.Month()), "day": t.Day()})
}

// duration is "3 分 08 秒" or "12 秒".
func duration(c *ui.Context, d time.Duration) string {
	d = d.Round(time.Second)
	m := int(d / time.Minute)
	s := int((d % time.Minute) / time.Second)
	if m == 0 {
		return trf(c, "durSeconds", map[string]any{"s": s})
	}
	return trf(c, "durMinutes", map[string]any{"m": m, "s": fmt.Sprintf("%02d", s)})
}

// keys writes a shortcut as the platform does: Ctrl+N on Windows and Linux,
// ⌘N on macOS.
func keys(k ...string) string {
	if runtime.GOOS == "darwin" {
		out := make([]string, len(k))
		for i, s := range k {
			switch s {
			case "Ctrl":
				s = "⌘"
			case "Shift":
				s = "⇧"
			}
			out[i] = s
		}
		return strings.Join(out, "")
	}
	return strings.Join(k, "+")
}

// keyCaps is keys split for kit.Theme.Keys.
func keyCaps(k ...string) []string {
	if runtime.GOOS != "darwin" {
		return k
	}
	out := make([]string, len(k))
	for i, s := range k {
		switch s {
		case "Ctrl":
			s = "⌘"
		case "Shift":
			s = "⇧"
		}
		out[i] = s
	}
	return out
}

// signed is "+45" and "−41".
func plus(n int) string  { return fmt.Sprintf("+%d", n) }
func minus(n int) string { return fmt.Sprintf("−%d", n) }
