// Package kit is omo's UI layer on top of Lobe MyGo. Views and plugin widgets
// draw through it, so the app's style lives in one place.
package ui

import (
	"github.com/QinYangWang/omo/pkg/action"
	"github.com/QinYangWang/omo/pkg/display"
	lobefield "github.com/QinYangWang/omo/pkg/field"
	"github.com/QinYangWang/omo/pkg/layout"
	lobemd "github.com/QinYangWang/omo/pkg/markdown"
	"github.com/QinYangWang/omo/pkg/overlay"
	"github.com/QinYangWang/omo/pkg/theme"
	mygoui "github.com/egoist/mygo/ui"
)

// Shell measurements shared by the chat shell and its panels.
const (
	SidebarWidth = 280
	DetailsWidth = 268
)

// Palette holds the colors omo needs beyond the theme roles: a rail behind the
// list, chat bubbles and mentions.
type Palette struct {
	Rail      mygoui.Color
	RailHover mygoui.Color
	Card      mygoui.Color
	Bubble    mygoui.Color
	User      mygoui.Color
	UserText  mygoui.Color
	Mention   mygoui.Color
	Border    mygoui.Color
	Text      mygoui.Color
	Muted     mygoui.Color
	Accent    mygoui.Color
	OnAccent  mygoui.Color
}

// Apply makes the frame use omo's Lobe UI theme. Call it at the top of every
// view.
func Apply(c *mygoui.Context) {
	theme.Apply(c)
}

// AgentAvatar states omo uses, re-exported so views do not import the kit's
// internals.
const (
	AgentIdle    = display.AgentIdle
	AgentWorking = display.AgentWorking
)

// Colors reads the palette of the theme the widgets being built take.
func Colors(c *mygoui.Context) Palette {
	tk := theme.TokensOf(c)
	p := Palette{
		Rail:      tk.BgContainer,
		RailHover: tk.FillTertiary,
		Card:      tk.FillSecondary,
		Bubble:    tk.FillTertiary,
		User:      tk.FillSecondary,
		UserText:  tk.Text,
		Mention:   tk.Orange,
		Border:    tk.Border,
		Text:      tk.Text,
		Muted:     tk.TextDescription,
		Accent:    tk.Primary,
		OnAccent:  tk.PrimaryForeground,
	}
	if tk.Dark {
		p.Bubble = tk.Fill
		p.User = tk.BgSolid
		p.UserText = tk.BgBase
	} else {
		p.Bubble = tk.FillTertiary
		p.User = tk.Fill
	}
	return p
}

// TextProps is the look of a piece of text.
type TextProps struct {
	Size  float32
	Bold  bool
	Muted bool
	Wrap  bool
	Grow  bool
	Fill  bool
}

// Text shows s as omo text: 13 DIP in the theme color unless Size says more.
func Text(c *mygoui.Context, s string, p TextProps) mygoui.Element {
	size := p.Size
	if size == 0 {
		size = 13
	}
	text := display.Text(c, s, display.TextProps{})
	text.FontSize(size)
	if p.Bold {
		text.FontWeight(700)
	}
	if p.Muted {
		text.TextColor(Colors(c).Muted)
	}
	if p.Wrap {
		text.Wrap()
	} else {
		text.SingleLine()
	}
	if p.Grow {
		text.Grow(1)
	}
	if p.Fill {
		text.FillWidth()
	}
	return text
}

// Heading shows s as a section title.
func Heading(c *mygoui.Context, s string, size float32) mygoui.Element {
	heading := display.Text(c, s, display.TextProps{})
	heading.FontSize(size).FontWeight(700)
	return heading
}

// ButtonProps is the look of a button.
type ButtonProps struct {
	Primary bool
	Fill    bool
}

// Button is an omo button; Primary fills it with the accent.
func Button(c *mygoui.Context, label string, p ButtonProps) mygoui.Element {
	variant := action.Default
	if p.Primary {
		variant = action.Primary
	}
	button := action.Button(c, label, action.ButtonProps{Variant: variant})
	if p.Fill {
		button.FillWidth()
	}
	return button
}

// IconToggle is a borderless square icon button, filled while active; ask the
// returned element whether it was Clicked.
func IconToggle(c *mygoui.Context, svg *mygoui.SVG, label string, active bool) mygoui.Element {
	return action.ActionIcon(c, svg, action.ActionIconProps{Size: theme.Small, Title: label, Active: active})
}

// IconButton is IconToggle without a state; it reports a click.
func IconButton(c *mygoui.Context, svg *mygoui.SVG, label string) bool {
	return IconToggle(c, svg, label, false).Clicked()
}

// AgentAvatar draws a Bot's generated agent face.
func AgentAvatar(c *mygoui.Context, name string, size float32, state display.AgentState) mygoui.Element {
	return display.AgentAvatar(c, display.AgentAvatarProps{
		Seed: name, Name: name, Size: size, State: state, Animated: true,
	})
}

// Avatar draws a person's avatar.
func Avatar(c *mygoui.Context, name string, size float32) mygoui.Element {
	return display.Avatar(c, name, display.AvatarProps{Size: size, Shape: display.AvatarCircle})
}

// Input is a single-line text field writing into value.
func Input(c *mygoui.Context, value *string, placeholder string) mygoui.Element {
	return lobefield.Input(c, value, lobefield.InputProps{Placeholder: placeholder})
}

// TextArea is a multi-line text field writing into value.
func TextArea(c *mygoui.Context, value *string, placeholder string, minRows, maxRows int) mygoui.Element {
	return lobefield.TextArea(c, value, lobefield.TextAreaProps{Placeholder: placeholder, MinRows: minRows, MaxRows: maxRows})
}

// Search is a search field writing into query.
func Search(c *mygoui.Context, query *string, placeholder string) mygoui.Element {
	return lobefield.SearchBar(c, query, lobefield.SearchBarProps{Placeholder: placeholder, Size: theme.Small})
}

// Segmented is a two-or-more way switch; selected is the index chosen.
func Segmented(c *mygoui.Context, selected *int, options []string) mygoui.Element {
	return action.Segmented(c, selected, options, action.SegmentedProps{Block: true, Size: theme.Small})
}

// CardProps is the room a card gives its children.
type CardProps struct {
	Padding int
	Gap     int
	Radius  int
}

// Card is a bordered surface grouping related content.
func Card(c *mygoui.Context, p CardProps) mygoui.Element {
	card := layout.Block(c, layout.BlockProps{Variant: layout.BlockOutlined}).
		FillWidth().
		Padding(float32(defaultInt(p.Padding, 12))).
		Gap(float32(defaultInt(p.Gap, 8)))
	if p.Radius > 0 {
		card.Radius(float32(p.Radius))
	}
	return card
}

// Popover shows content above anchor while *open is true; the anchor toggles
// it, and a click outside or Escape closes it.
func Popover(c *mygoui.Context, anchor mygoui.Element, open *bool, content func()) mygoui.Element {
	return overlay.Popover(c, anchor, open, overlay.PopoverProps{Placement: overlay.Top}, content)
}

// Divider separates content.
func Divider(c *mygoui.Context) mygoui.Element {
	return layout.Divider(c, layout.DividerProps{})
}

// MarkdownProps is how Markdown renders.
type MarkdownProps struct {
	// Animated tells a reply still being written.
	Animated bool
}

// Markdown renders a message body in the chat type scale.
func Markdown(c *mygoui.Context, src string, p MarkdownProps) mygoui.Element {
	return lobemd.Markdown(c, src, lobemd.MarkdownProps{Variant: lobemd.Chat, Animated: p.Animated})
}

// MenuItem is one row of a dropdown menu.
type MenuItem = overlay.MenuItem

// DropdownMenu shows items below the trigger while *open is true and returns
// the key chosen in this frame, or "".
func DropdownMenu(c *mygoui.Context, open *bool, items []MenuItem, trigger func(t mygoui.Element)) string {
	return overlay.DropdownMenu(c, open, overlay.DropdownMenuProps{Items: items}, trigger)
}

// StepSlider is a slider that moves in whole steps between lo and hi.
func StepSlider(c *mygoui.Context, value *float64, lo, hi, step float64) mygoui.Element {
	return mygoui.StepSlider(c, value, lo, hi, step)
}
