// Package widgets renders omo's declarative native UI plugin language.
package widgets

import mygoui "github.com/egoist/mygo/ui"

type Node struct {
	Type        string `json:"type"`
	Text        string `json:"text,omitempty"`
	Bind        string `json:"bind,omitempty"`
	Key         string `json:"key,omitempty"`
	Placeholder string `json:"placeholder,omitempty"`
	Action      string `json:"action,omitempty"`
	Arg         string `json:"arg,omitempty"`
	Empty       string `json:"empty,omitempty"`

	Width   int  `json:"width,omitempty"`
	Height  int  `json:"height,omitempty"`
	Padding int  `json:"padding,omitempty"`
	Gap     int  `json:"gap,omitempty"`
	Radius  int  `json:"radius,omitempty"`
	Font    int  `json:"fontSize,omitempty"`
	Grow    bool `json:"grow,omitempty"`
	Fill    bool `json:"fill,omitempty"`
	Bold    bool `json:"bold,omitempty"`
	Primary bool `json:"primary,omitempty"`
	Wrap    bool `json:"wrap,omitempty"`

	Children []Node `json:"children,omitempty"`
	Item     *Node  `json:"item,omitempty"`
}

type Host interface {
	Value(path string) any
	Perform(action, arg string) error
	Fail(error)
	RenderTranscript(*mygoui.Context)
	RenderComposer(*mygoui.Context)
	RenderSessions(*mygoui.Context)
}
