//go:build !js

package field

import (
	"testing"

	"github.com/egoist/mygo/i18n"
)

func TestUploadFilterSpeaksTheAppsLanguage(t *testing.T) {
	i18n.SetLocaleFunc(func() string { return "zh-Hans" })
	t.Cleanup(func() { i18n.SetLocaleFunc(nil) })
	if got := acceptFilters(".pdf"); len(got) != 1 || got[0].Name != "支持的文件" {
		t.Errorf("filters %+v, want one named 支持的文件", got)
	}
}
