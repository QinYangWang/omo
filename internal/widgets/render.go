package widgets

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	mygoui "github.com/egoist/mygo/ui"
)

var templatePattern = regexp.MustCompile(`\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}`)

func Render(c *mygoui.Context, root *Node, state *State, host Host) {
	if root == nil {
		host.Fail(fmt.Errorf("plugin UI is empty"))
		return
	}
	renderNode(c, root, state, host, nil, "root", 0)
}

func renderNode(c *mygoui.Context, node *Node, state *State, host Host, scope map[string]any, path string, index int) {
	if node == nil {
		return
	}
	t := c.Theme()
	key := node.Key
	if key == "" {
		key = fmt.Sprintf("%s-%d", path, index)
	}
	text := resolveText(node.Text, scope, host)
	switch node.Type {
	case "page":
		mygoui.Column(c).Fill().Padding(float32(node.Padding)).Gap(float32(node.Gap)).Background(t.Background).Children(func() {
			renderChildren(c, node, state, host, scope, path)
		})
	case "column":
		column := mygoui.Column(c).Padding(float32(node.Padding)).Gap(float32(node.Gap))
		if node.Grow {
			column.Grow(1)
		}
		if node.Fill {
			column.Fill()
		}
		if node.Width > 0 {
			column.Width(float32(node.Width))
		}
		if node.Height > 0 {
			column.Height(float32(node.Height))
		}
		column.Children(func() { renderChildren(c, node, state, host, scope, path) })
	case "row":
		row := mygoui.Row(c).Padding(float32(node.Padding)).Gap(float32(node.Gap)).AlignItems(mygoui.Center)
		if node.Grow {
			row.Grow(1)
		}
		if node.Fill {
			row.Fill()
		}
		if node.Width > 0 {
			row.Width(float32(node.Width))
		}
		if node.Height > 0 {
			row.Height(float32(node.Height))
		}
		row.Children(func() { renderChildren(c, node, state, host, scope, path) })
	case "card":
		mygoui.Column(c).
			FillWidth().
			Padding(float32(defaultInt(node.Padding, 12))).
			Gap(float32(defaultInt(node.Gap, 8))).
			Radius(float32(defaultInt(node.Radius, 10))).
			Background(t.Surface).
			Children(func() { renderChildren(c, node, state, host, scope, path) })
	case "header":
		mygoui.Row(c).Padding(float32(node.Padding)).Gap(10).AlignItems(mygoui.Center).Children(func() {
			mygoui.Text(c, text).FontSize(float32(defaultInt(node.Font, 18))).Bold()
			renderChildren(c, node, state, host, scope, path)
		})
	case "heading":
		mygoui.Text(c, text).FontSize(float32(defaultInt(node.Font, 20))).Bold()
	case "text", "label":
		value := mygoui.Text(c, text).FontSize(float32(defaultInt(node.Font, 12)))
		if node.Bold {
			value.Bold()
		}
		if node.Wrap {
			value.Wrap()
		}
		if node.Grow {
			value.Grow(1)
		}
		if node.Fill {
			value.FillWidth()
		}
	case "button":
		var button mygoui.Element
		if node.Primary {
			button = mygoui.PrimaryButton(c, text)
		} else {
			button = mygoui.Button(c, text)
		}
		if node.Fill {
			button.FillWidth()
		}
		if button.Clicked() {
			if err := host.Perform(node.Action, resolveText(node.Arg, scope, host)); err != nil {
				host.Fail(err)
			}
		}
	case "input":
		mygoui.TextInput(c, state.String(key)).FillWidth().Placeholder(resolveText(node.Placeholder, scope, host))
	case "textarea":
		lines := defaultInt(node.Height, 4)
		mygoui.TextArea(c, state.String(key)).Lines(lines, lines).FillWidth().Placeholder(resolveText(node.Placeholder, scope, host))
	case "divider":
		mygoui.Divider(c)
	case "spacer":
		mygoui.Spacer(c)
	case "list":
		renderList(c, node, state, host, scope, key)
	case "chat.transcript":
		host.RenderTranscript(c)
	case "chat.composer":
		host.RenderComposer(c)
	case "sessions.list":
		host.RenderSessions(c)
	default:
		mygoui.Text(c, fmt.Sprintf("Unknown widget type %q", node.Type)).TextColor(t.Danger).FontSize(11)
	}
}

func renderChildren(c *mygoui.Context, node *Node, state *State, host Host, scope map[string]any, path string) {
	for i := range node.Children {
		renderNode(c, &node.Children[i], state, host, scope, path+"/"+node.Type, i)
	}
}

func renderList(c *mygoui.Context, node *Node, state *State, host Host, scope map[string]any, key string) {
	t := c.Theme()
	items := toItems(lookup(scope, host, node.Bind))
	if len(items) == 0 {
		empty := node.Empty
		if empty == "" {
			empty = "No items"
		}
		mygoui.Text(c, empty).FontSize(11).TextColor(t.TextMuted)
		return
	}
	list := state.List(key)
	list.Key = func(i int) any {
		if i < 0 || i >= len(items) {
			return i
		}
		for _, idKey := range []string{"id", "key", "title"} {
			if value, ok := items[i][idKey]; ok {
				return fmt.Sprint(value)
			}
		}
		return i
	}
	mygoui.List(c, list, len(items), func(i int) {
		itemScope := items[i]
		if node.Item == nil {
			mygoui.Text(c, stringify(itemScope["text"])).FontSize(12)
			return
		}
		renderNode(c, node.Item, state, host, itemScope, key+"/item", i)
	})
}

func lookup(scope map[string]any, host Host, path string) any {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	parts := strings.Split(path, ".")
	var current any
	if scope != nil {
		if value, ok := scope[parts[0]]; ok {
			current = value
			parts = parts[1:]
		}
	}
	if current == nil {
		current = host.Value(path)
		parts = nil
	}
	for _, part := range parts {
		object, ok := current.(map[string]any)
		if !ok {
			return ""
		}
		current = object[part]
	}
	return current
}

func resolveText(template string, scope map[string]any, host Host) string {
	if template == "" {
		return ""
	}
	return templatePattern.ReplaceAllStringFunc(template, func(match string) string {
		groups := templatePattern.FindStringSubmatch(match)
		if len(groups) != 2 {
			return match
		}
		return stringify(lookup(scope, host, groups[1]))
	})
}

func stringify(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case fmt.Stringer:
		return typed.String()
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(typed)
	default:
		data, err := json.Marshal(typed)
		if err != nil {
			return fmt.Sprint(typed)
		}
		return string(data)
	}
}

func toItems(value any) []map[string]any {
	switch typed := value.(type) {
	case []map[string]any:
		return typed
	case []any:
		out := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			switch value := item.(type) {
			case map[string]any:
				out = append(out, value)
			default:
				out = append(out, map[string]any{"text": value})
			}
		}
		return out
	case []string:
		out := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, map[string]any{"text": item, "title": item})
		}
		return out
	default:
		return nil
	}
}

func defaultInt(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}
