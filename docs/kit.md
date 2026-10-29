# UI Kit：`internal/kit`

`internal/kit` 是这个窗口的设计系统：颜色、字号、间距（token），加上每个面板都由之拼起来的组件。
思路照搬 shadcn/ui，只是换成 MyGo 的立即模式——`Theme` 持有 token，组件是读 token 的函数，
换皮只改 `internal/kit` 一处，不改面板。

**面板里不要写颜色字面量、字号数字、行高数字，也不要直接拼 `ui.Box` 来做"行/开关/标题"。**
用本文的 token 和组件。

## 上手

`kit.New(c)` 每帧在根调用一次（`view.Shell` 已经调了）：它把 palette 交给窗口控件，
返回本帧的 token。子面板把 `kit.Theme` 当参数往下传，**不要**在每个面板里重复 `kit.New`。

```go
func myPanel(c *ui.Context, a *app.App, st kit.Theme) {
	loc := c.Locale()
	ui.Column(c).Fill().Background(st.Panel).Children(func() {
		st.SectionRow(c, i18n.T(loc, "mySection"))
		st.Row(c, kit.RowSpec{
			Icon:    kit.IconFileCode,
			Label:   "main.go",
			Meta:    "M",
			MetaClr: st.Warning,
			OnClick: func() { a.Dispatch(app.OpenFile{Path: "main.go"}) },
		})
		st.IconButton(c, kit.IconRefresh, i18n.T(loc, "refresh"), false, func() {
			a.Dispatch(app.RefreshChanges{})
		})
	})
}
```

## Token（`kit.Theme`）

| 字段 | 用途 |
|---|---|
| `BG` | 编辑器、终端的底：窗口里最亮的那块 |
| `Panel` | 外壳的底：顶栏、两侧栏、状态栏、底部面板 |
| `Surface` / `SurfaceHover` / `SurfacePressed` | 控件面（按钮、输入框），悬停与按下 |
| `Border` | 所有 1 DIP 分隔线；不要用 `Surface` 当线 |
| `Text` / `Muted` / `Faint` | 正文 / 次要文字 / 提示文字 |
| `Accent` / `AccentText` | 强调色（图标、焦点、激活标记）及其上的文字 |
| `Fill` / `FillText` | 实心按钮的底与文字（`ui.PrimaryButton` 用） |
| `Hover` / `Selected` | 行悬停、行被选中（半透明，可叠在 `Panel`/`BG` 上） |
| `Success` / `Danger` / `Warning` | 加/删/改、错误、警告 |
| `Line` / `Guide` / `Gutter` / `Selection` / `Tokens` | 编辑器专用：光标行、缩进线、行号、选中、语法配色 |
| `FontMeta` / `FontUI` / `FontList` | 11 / 12.5 / 12.5 DIP：小标题、界面文字、列表行 |
| `RowH` / `TabH` / `TitleH` / `BarH` / `HeadH` | 列表行 24、标签条 34、面板标题 30、状态栏 26、顶栏 38 |
| `Pad` / `Gap` | 面板内边距 10、控件间距 6 |
| `LeftW` / `RightW` | 左侧会话栏 260、右侧栏 280 |

明暗两套在 `internal/kit/theme.go` 的 `darkPalette()` / `lightPalette()`，程序跟随系统外观。

## 组件

组件都是 `func (t Theme) X(c *ui.Context, ...)`，在 `c` 上往下画，返回 `void`。

| 组件 | 签名要点 | 用在哪 |
|---|---|---|
| `HRule` / `VRule` | 无参数 | 面板之间的 1 DIP 分隔线（横/竖） |
| `TabStrip` / `ActiveTab` | 返回颜色 | 标签条底、激活标签底（明暗两套都"浮"起来） |
| `Row` | `kit.RowSpec` | 文件树、改动列表、会话列表：一行文字 + 图标 + 右侧标记 |
| `IconColor` | `(active bool) ui.Color` | 行图标的"安静/点亮"两态 |
| `SectionLabel` / `SectionRow` | 文本 | 面板里的小写标题（会转大写并加字距） |
| `SectionHeader` | `(title string, open *bool)` | 可折叠分区标题（文件树的根节点） |
| `Chip` | `(label string, active bool, onClick func())` | 轻量开关：状态栏 `Panel` / `Sidebar`、终端页签 |
| `IconChip` | 同上 + `*ui.SVG` | 带图标的轻量开关（终端 / 问题 / 输出） |
| `IconButton` | `(icon, label, active, onClick)` | 外壳里的方形图标按钮；`label` 同时是 tooltip 与无障碍名 |
| `ActionRow` | `(icon, label, meta, onClick)` | 宽动作行：欢迎页、会话窗口、运行页的快捷指令 |
| `IconTabs` | `[]kit.IconTab` | 右侧栏的图标标头；`Active` 的是当前页 |
| `EmptyState` | `(icon, text)` | 没有内容可显示的面板 |
| `FileIcon` | `(name string) (*ui.SVG, ui.Color)` | 按扩展名给文件图标与语言色 |
| `EditorTheme` | `c *ui.Context` | 编辑器 / diff 的配色，从 token 生成 |
| `Lang` | `(dark, light string) ui.Color` | 语言色在明暗两套下的取值 |

`RowSpec` 的字段：`Indent`（缩进像素）、`Arrow`（折叠箭头）、`Icon`/`IconClr`、
`Dot`（未保存圆点）、`Label`、`Meta`/`MetaClr`（右侧小字，如 git 状态）、`Active`、`Tip`（tooltip）、`OnClick`。

## 图标

`kit.Icon*` 是 Lucide 的 24×24 描边图标，颜色跟随文字。要加图标：

```go
// internal/kit/icons.go
IconFilter = lucide(`<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>`)
```

并把名字加进 `internal/kit/kit_test.go` 的 `TestIconsParse`，解析失败会在启动日志里报错而不是崩。

## 配方

### 给右侧栏加一页

1. `internal/i18n/locales/{en,zh-Hans}.json` 加标题 key（如 `sidebarTimeline`）。
2. `internal/app/app.go` 的 `Layout.RightSel` 约定新 id（如 `"timeline"`）；需要新状态就加 intent。
3. `internal/view/shell.go` 写 `func timelinePanel(c, a, st kit.Theme)`，用 `st.Row` / `st.EmptyState` 组合。
4. `rightSidebar` 的 `switch` 加 `case "timeline"`；`rightHeader` 的 `IconTabs` 加一项：

```go
{Icon: kit.IconFilter, Label: i18n.T(loc, "sidebarTimeline"), Active: active("timeline"), OnClick: page("timeline")},
```

5. 测试：`internal/view/shell_test.go` 点一次这个 label 断言 `Layout.RightSel`；
   `TestWriteScreenshots` 里加一张（见下文）。

### 加一条快捷指令（运行页）

`internal/view/shell.go` 的 `quickCommands`：按项目根目录的标记文件（`go.mod`、`Makefile`…）返回
`quickCommand{key, args}`，`args` 直接在项目根目录的新终端里跑（`app.RunCommand`）。
新语言就加一个 case，不需要新面板。

### 加一个 token

三处一起改，否则明暗会不一致：

1. `internal/kit/theme.go` 的 `palette` 加字段，并在 `darkPalette()` / `lightPalette()` 赋值；
2. `Theme` 加同名字段（导出，大驼峰）；
3. `newTheme()` 从 palette 抄进 `Theme`。

### 加一种文件图标

`internal/kit/icons.go` 的 `Theme.FileIcon` 的 `switch ext`：选图标 + `t.Lang(深色, 浅色)`。

## 规则（都是踩过的坑）

- **不要用 `Fill()` 画 1 DIP 线**：`Fill` 两个方向都撑满，线会变成整块遮住下面的内容（`FillWidth`/`FillHeight`）。
- **点击目标不要嵌套**：可点元素内部的按钮必须是它的兄弟节点（见标签页的 `×`）。
- 字号、行高、宽度一律用 token；`12`、`24`、`260` 这类数字只出现在 `theme.go`。
- 面板文案一律 `i18n.T` / `i18n.Tf`，两个 locale 都加。
- 纯图标组件必须给 `Label`（`IconButton` / `IconTabs` 已经内置），否则无障碍树里是空的、测试也点不到。
- 不嵌 webview、不在窗口里跑 HTML：需要浏览器就交给系统默认浏览器（`app.OpenURL`）。
- 面板底部/右侧的留白用 `st.Pad`，不要 `Padding(16)`。

## 测试

- 组件自己的测试：`internal/kit/kit_test.go`（`ui.NewTester` + `tt.Click(标签)` + 断言回调）。
- 面板的测试：`internal/view/shell_test.go`（真实 `app.App` + 临时工作区）。
- 截图：`OMO_SCREENSHOTS=1 go test ./internal/view -run TestWriteScreenshots` 重写 `docs/ui/*.png`；
  不带环境变量时该测试直接 skip，所以 `go test ./...` 不会改仓库。
