package action

import (
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/QinYangWang/omo/pkg/internal/l10n"
	"github.com/QinYangWang/omo/pkg/lucide"
	"github.com/QinYangWang/omo/pkg/theme"
)

type CopyButtonProps struct {
	// Variant picks the surface, as ActionIcon's.
	Variant ActionIconVariant
	// Size sets the button and icon size, as ActionIcon's.
	Size theme.Size
	// Icon replaces the copy icon.
	Icon *ui.SVG
}

const copiedFor = 2 * time.Second

// CopyButton copies content to the clipboard when clicked, and shows a check and says "Copied"
// for two seconds after.
func CopyButton(c *ui.Context, content string, p CopyButtonProps) ui.Element {
	b := ui.ButtonBase(c)
	if b.Clicked() {
		c.WriteClipboard(content)
		b.Jump("copied", 1)
	}
	copied := b.AnimateTo("copied", 0, ui.Animation{Duration: copiedFor}) > 0
	icon, title := p.Icon, l10n.Text(c, "copy")
	if icon == nil {
		icon = lucide.Copy()
	}
	if copied {
		icon, title = lucide.Check(), l10n.Text(c, "copied")
	}
	return StyleActionIcon(c, b, icon, ActionIconProps{Variant: p.Variant, Size: p.Size, Title: title, Active: copied})
}
