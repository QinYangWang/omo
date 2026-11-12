package ui

import mygoui "github.com/egoist/mygo/ui"

// palette holds the few colors this design needs beyond MyGo's theme roles:
// a darker rail behind the session list and a raised card face.
type palette struct {
	rail      mygoui.Color
	railHover mygoui.Color
	card      mygoui.Color
	border    mygoui.Color
	text      mygoui.Color
	muted     mygoui.Color
	accent    mygoui.Color
	onAccent  mygoui.Color
}

func colors(t *mygoui.Theme) palette {
	if t.Dark {
		return palette{
			rail:      mygoui.Hex("#121214"),
			railHover: mygoui.Hex("#1e1e23"),
			card:      mygoui.Hex("#202025"),
			border:    mygoui.Hex("#2a2a31"),
			text:      mygoui.Hex("#ececef"),
			muted:     mygoui.Hex("#8a8a94"),
			accent:    mygoui.Hex("#7c6cff"),
			onAccent:  mygoui.Hex("#ffffff"),
		}
	}
	return palette{
		rail:      mygoui.Hex("#f5f5f7"),
		railHover: mygoui.Hex("#ebebef"),
		card:      mygoui.Hex("#ffffff"),
		border:    mygoui.Hex("#e3e3e8"),
		text:      mygoui.Hex("#17171a"),
		muted:     mygoui.Hex("#6b6b75"),
		accent:    mygoui.Hex("#6d5cf0"),
		onAccent:  mygoui.Hex("#ffffff"),
	}
}

// theme returns the window theme in the neutral dark/light palette of the
// reference layout, keeping the desktop's accent and text scale.
func theme(base *mygoui.Theme) *mygoui.Theme {
	t := *base
	p := colors(&t)
	main := mygoui.Hex("#17171a")
	if !t.Dark {
		main = mygoui.Hex("#fdfdfe")
	}
	t.Background = main
	t.Surface = p.card
	t.SurfaceHover = p.railHover
	t.SurfacePressed = p.border
	t.Border = p.border
	t.Text = p.text
	t.TextMuted = p.muted
	t.Accent = p.accent
	t.AccentText = p.onAccent
	t.InactiveAccent = p.accent
	t.Radius = 9
	t.Spacing = 4
	t.FontSize = 13
	if t.Dark {
		t.Scrollbar = mygoui.RGBA(255, 255, 255, 0.18)
		t.Inverse = mygoui.Hex("#26262c")
		t.InverseText = p.text
	} else {
		t.Scrollbar = mygoui.RGBA(0, 0, 0, 0.22)
		t.Inverse = mygoui.Hex("#26262c")
		t.InverseText = mygoui.Hex("#f4f4f5")
	}
	t.ScrollbarWidth = 8
	return &t
}
