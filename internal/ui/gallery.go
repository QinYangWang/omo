package ui

import (
	"fmt"

	mygoui "github.com/egoist/mygo/ui"
)

// gallery is a page of the app's own components in their states, so a style
// change can be checked in one place. The rail opens it; it is not a product
// screen.
func (v *view) galleryPage(c *mygoui.Context) {
	t := c.Theme()
	mygoui.Row(c).Fill().Background(t.Background).Children(func() {
		v.rail(c)
		mygoui.Column(c).Grow(1).FillHeight().Children(func() {
			v.headerBar(c, "Components", "", func() {
				if IconButton(c, iconArrowLeft, "Back to chat") {
					v.gallery = false
				}
			})
			mygoui.Scroll(c).Grow(1).Children(func() {
				mygoui.Column(c).FillWidth().Padding(20, 24, 20, 24).Gap(22).Children(func() {
					gallerySection(c, "Text", func() {
						Text(c, "Body text", TextProps{})
						Text(c, "Muted text", TextProps{Muted: true})
						Text(c, "Bold text", TextProps{Bold: true})
						Heading(c, "Heading", 17)
					})
					gallerySection(c, "Buttons", func() {
						mygoui.Column(c).MaxWidth(520).Gap(8).Children(func() {
							mygoui.Row(c).Wrap().Gap(8).AlignItems(mygoui.Center).Children(func() {
								Button(c, "Primary", ButtonProps{Primary: true})
								Button(c, "Default", ButtonProps{})
								IconButton(c, iconPlus, "Add")
								IconToggle(c, iconGrid, "Active", true)
							})
							Button(c, "Wide", ButtonProps{Fill: true})
						})
					})
					gallerySection(c, "Inputs", func() {
						mygoui.Column(c).MaxWidth(460).Gap(8).Children(func() {
							Input(c, &v.galName, "Name").FillWidth()
							TextArea(c, &v.galNotes, "Notes", 2, 4).FillWidth()
							Search(c, &v.galQuery, "Search").FillWidth()
						})
					})
					gallerySection(c, "Segmented", func() {
						mygoui.Column(c).MaxWidth(520).Gap(8).Children(func() {
							Segmented(c, &v.galTab, []string{"Library", "Members"})
							Text(c, fmt.Sprintf("Selected: %d", v.galTab), TextProps{Size: 11, Muted: true})
						})
					})
					gallerySection(c, "Avatars", func() {
						mygoui.Row(c).Gap(10).AlignItems(mygoui.Center).Children(func() {
							AgentAvatar(c, "Atlas", 40, AgentIdle)
							AgentAvatar(c, "Forge", 40, AgentWorking)
							AgentAvatar(c, "Pulse", 32, AgentIdle)
							Avatar(c, "You", 36)
						})
					})
					gallerySection(c, "Card and divider", func() {
						Card(c, CardProps{}).Children(func() {
							Text(c, "A card groups related content.", TextProps{})
							Divider(c)
							Text(c, "With a divider inside.", TextProps{Muted: true})
						})
					})
					gallerySection(c, "Menu", func() {
						items := []MenuItem{
							{Key: "one", Label: "First item", Extra: "1"},
							{Key: "two", Label: "Second item"},
							{Key: "three", Label: "Disabled item", Disabled: true},
						}
						chosen := DropdownMenu(c, &v.galMenu, items, func(t mygoui.Element) {
							chip := t.Row().Height(28).PaddingX(8).Gap(6).AlignItems(mygoui.Center).
								Radius(8).Label("Open menu")
							if chip.Hovered() || v.galMenu {
								chip.Background(Colors(c).RailHover)
							}
							chip.Children(func() {
								mygoui.Text(c, "Open menu")
								mygoui.Icon(c, iconChevron).FontSize(12)
							})
						})
						if chosen != "" {
							v.galChosen = chosen
						}
						if v.galChosen != "" {
							Text(c, "Chosen: "+v.galChosen, TextProps{Size: 11, Muted: true})
						}
					})
					gallerySection(c, "Thinking slider", func() {
						StepSlider(c, &v.galValue, 0, 4, 1).MaxWidth(260)
						Text(c, fmt.Sprintf("Step %.0f", v.galValue), TextProps{Size: 11, Muted: true})
					})
					gallerySection(c, "Markdown", func() {
						Markdown(c, "### A heading\n\nSome **strong** text and `code`.\n\n1. one\n2. two", MarkdownProps{})
					})
					gallerySection(c, "Palette", func() {
						p := Colors(c)
						swatches := []struct {
							name string
							c    mygoui.Color
						}{{"accent", p.Accent}, {"text", p.Text}, {"muted", p.Muted}, {"border", p.Border},
							{"rail", p.Rail}, {"card", p.Card}, {"bubble", p.Bubble}, {"user", p.User}, {"mention", p.Mention}}
						mygoui.Row(c).Wrap().Gap(8).Children(func() {
							for _, swatch := range swatches {
								mygoui.Column(c).Gap(4).Children(func() {
									mygoui.Box(c).Size(48, 28).Radius(6).Background(swatch.c).
										Border(1, p.Border)
									mygoui.Text(c, swatch.name).FontSize(10).TextColor(p.Muted)
								})
							}
						})
					})
				})
			})
		})
	})
}

func gallerySection(c *mygoui.Context, title string, fn func()) {
	mygoui.Column(c).FillWidth().Gap(8).Children(func() {
		Text(c, title, TextProps{Size: 11, Muted: true, Bold: true})
		fn()
	})
}
