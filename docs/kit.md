# UI Kit：`internal/kit`

`internal/kit` 是这个窗口的设计系统：颜色、字号、间距（token），加上每个面板都由之拼起来的组件。
思路照搬 shadcn/ui，只是换成 MyGo 的立即模式——`Theme` 持有 token，组件是读 token 的函数，
换皮只改 `internal/kit` 一处，不改面板。

**面板里不要写颜色字面量、字号数字、行高数字，也不要直接拼 `ui.Box` 来做"行/开关/标题"。**
用本文的 token 和组件。

规则（什么样的界面算对）在 [DESIGN.md](../DESIGN.md)：本文只讲怎么用 kit。

## 上手

`kit.NewFor(c, mode)` 每帧在根调用一次（`view.Shell` 已经调了）：它把 palette 交给窗口控件，
返回本帧的 token。子面板把 `kit.Theme` 当参数往下传，**不要**在每个面板里重复调用。

```go
func myPanel(c *ui.Context, a *app.App, st kit.Theme) {
	ui.Column(c).Fill().Children(func() {
		st.Section(c, tr(c, "mySection"), nil)
		st.Row(c, kit.RowSpec{
			Icon:    kit.IconFileDiff,
			IconClr: st.StatusColor("M"),
			Label:   "main.go",
			Mono:    true,
			Badge:   "M",
			OnClick: func() { a.Dispatch(app.OpenDiff{Path: "main.go"}) },
		})
		st.Btn(c, kit.Button{Label: tr(c, "commit"), Kind: kit.ButtonPrimary, Small: true}, func() {
			a.Dispatch(app.CommitChanges{})
		})
	})
}
```

## Token（`kit.Theme`）

值与用途见 [DESIGN.md](../DESIGN.md) §2；这里只列字段。`kit.New(c)` 跟随系统外观，
`kit.NewFor(c, kit.Mode(a.Prefs().Theme))`（`view.Shell` 用它）按 设置 → 外观 的选择。

| 字段 | 用途 |
|---|---|
| `BG` / `Side` / `Surface` / `Raised` | 主区 / 侧栏与设置导航 / 卡片与输入框 / 弹层 |
| `Hover` / `Selected` | 悬停 / 选中行 |
| `Border` / `Border2` | 分隔线 / 控件描边 |
| `Text` / `Text2` / `Text3` | 正文 / 次要 / 注释 |
| `Accent` / `AccentBg` / `OnAccent` | 唯一强调色、它的淡底、强调色上的字 |
| `OK` `OKBg` / `Warn` `WarnBg` `WarnLine` / `Err` `ErrBg` `ErrLine` | 状态色、淡底、描边 |
| `AddBg` / `DelBg` / `Code` / `Scrim` / `Shadow` | diff 行 / 代码井 / 遮罩 / 唯一阴影 |
| `Panel` `Muted` `Faint` `Success` `Danger` `Warning` | 兼容别名（= Side、Text2、Text3、OK、Err、Warn），给编辑器用 |
| `Line` / `Guide` / `Gutter` / `Selection` / `Tokens` | 编辑器与 diff |
| `FontMeta` 11 / `FontSmall` 12 / `FontRow` 12.5 / `FontUI` 13 / `FontTitle` 13.5 / `FontH1` 20 / `FontDisplay` 30 | 字号 |
| `RowH` 30 / `HeadH` 48 / `CtlH` 30 / `BarH` 34 | 高度 |
| `Pad` 16 / `Gap` 8 | 间距 |
| `RadiusTag` 4 / `RadiusS` 6 / `RadiusM` 10 / `RadiusL` 12 | 圆角 |
| `SideW` 252 / `InspectorW` 300 / `PanelW` 520 / `SettingsNavW` 236 / `ColumnW` 720 | 固定宽度 |

字体：`kit.FontSans`（Geist）与 `kit.FontMono`（Geist Mono），`kit.RegisterFonts()` 注册嵌入的 OFL 字体。

## 组件

组件都是 `func (t Theme) X(c *ui.Context, ...)`，在 `c` 上往下画。

| 组件 | 用在哪 |
|---|---|
| `HRule` / `VRule` | 1 DIP 分隔线 |
| `Mono` / `Label` | 等宽文本（路径、命令、数字）/ 单行界面文本 |
| `Btn(kit.Button{Label, Icon, Kind, Small, Key, Width})` | 主按钮（`ButtonPrimary`，钴蓝）、默认（描边）、幽灵；`Key` 画键帽（允许一次 `Enter`） |
| `IconButton` | 28 DIP 图标按钮，`label` 是 tooltip 和无障碍名 |
| `TitleButton` | 标题栏按钮（计划、`+N −N`） |
| `Chip` | 24 DIP 描边芯片（Agent、项目、分支） |
| `NavItem` | 30 DIP 导航行（侧栏动作、设置页），右侧可带快捷键 |
| `Section` / `SmallIconButton` | 侧栏分组标签与它右侧的小动作 |
| `Tag(icon, label, tone)` / `Dot(tone)` | 20 DIP 状态标签 / 7 DIP 状态点；`ToneOff` 是空心环 |
| `Keys(...)` / `KeyHint` | 键帽 / 纯文本快捷键 |
| `Seg(&sel, labels...)` | 分段控件（Side 井 + Surface 选中） |
| `Switch(&on)` / `Toggle(on, label, fn)` | 开关：绑定字段 / 调用方自己改值 |
| `SelectBox(label, &sel, options)` | 下拉外观；点一次换下一项（无弹层，状态真实） |
| `Card` / `SettingsCard(rows...)` / `SettingRow(title, desc, control)` | 卡片 / 带分隔的设置卡 / 设置行 |
| `Bar(frac, width, color)` | 4 DIP 进度条（计划进度） |
| `Avatar` / `AgentMark` | 用户首字母 / Agent 标识（首字母方块，Pi 用 `pi` 字形） |
| `Popover(e)` | 浮层样式：Raised + Border2 + 12 圆角 + 唯一阴影 |
| `EmptyState(icon, title, text)` | 没有内容时 |
| `Row(kit.RowSpec)` | 列表行：缩进、图标（状态色）、mono 标签、右侧计数与状态字母 |
| `DiffBlock` / `CodeWell` | diff 行（38 DIP 行号 + 符号列 + 整行淡底）/ 终端与进程输出 |
| `FileIcon` / `StatusColor` | 文件图标（统一 `Text3`）/ A·M·D 的状态色 |

## 图标

`kit.Icon*` 是官方 [Lucide](https://lucide.dev/icons/) 图标（ISC 许可，见 `internal/kit/icons/LICENSE`）：
`internal/kit/icons/*.svg` 就是 lucide.dev 上那些原文件，`go:embed` 打进二进制，所以发布版画的
图标就是构建时那一套。`IconLogo` 是 omo 自己的标记，不是 Lucide 的。

要加或换一个图标：

1. `internal/kit/icons.go` 加一行 `IconFilter = mustIcon("filter")`——参数就是 lucide.dev 上的图标名；
2. 跑 `./scripts/lucide-icons.sh`：脚本从 `icons.go` 里读名字下载对应 `.svg`，并删掉不再引用的文件；
3. 把名字加进 `internal/kit/kit_test.go` 的 `TestIconsParse`（解析失败只写日志，不会崩）。

脚本默认从 `lucide-static@1.70.0`（Doop 设计用的版本）取图标；Lucide 的 main 分支会重命名或删掉图标，
脚本遇到 404 会直接报名字。`mustIcon` 把描边从 2 改成设计用的 1.75。**不要手抄 SVG path**：手抄的那套已经在换成官方文件时删掉了。

## 配方

### 给会话的侧面板加一页

1. `internal/i18n/locales/{en,zh-Hans}.json` 加标题 key（如 `panelTimeline`）。
2. `internal/app/console.go` 加常量 `PanelTimeline = "timeline"`；`ToggleSidePanel{Name}` 已经能开关它。
3. `internal/view/inspector.go`：`sidePanel` 的 tab 行加一个 `panelTab(...)`，`switch` 加 `case app.PanelTimeline`，
   页面本身用 `st.Row` / `st.EmptyState` 组合。
4. 测试：`internal/view/shell_test.go` 点一次这个 label；`screenshots_test.go` 的 `shotScreens` 加一屏。

### 加一个设置页

`internal/view/settings.go`：`settingsPages` 加一项（id、图标、标题 key、分组 key），`settingsPageBody` 的 `switch`
加一个 `page…` 函数，用 `pageHead` + `h2` + `st.SettingsCard(segRow/switchRow/selectRow…)` 组合。要存的值放进
`app.Prefs`（JSON 存在元数据库里，设置窗口关闭时保存）。

### 加一条快捷指令

快捷指令是用户数据（`Prefs.Prompts`），在 设置 → 快捷指令 里编辑；内置的三条在 `app.defaultPrefs`。

### 加一个 token

三处一起改，否则明暗会不一致：

1. `internal/kit/theme.go` 的 `palette` 加字段，并在 `darkPalette()` / `lightPalette()` 赋值；
2. `Theme` 加同名字段（导出，大驼峰）；
3. `NewFor()` 从 palette 抄进 `Theme`。

### 加一种文件图标

`internal/kit/icons.go` 的 `Theme.FileIcon` 的 `switch ext`：只选图标；颜色由调用方按状态（`StatusColor`）给。

## 规则（都是踩过的坑）

- **不要用 `Fill()` 画 1 DIP 线**：`Fill` 两个方向都撑满，线会变成整块遮住下面的内容（`FillWidth`/`FillHeight`）。
- **点击目标不要嵌套**：可点元素内部的按钮必须是它的兄弟节点（见定时任务表格行与它的开关）。
- 浮层用 `view.floating`：遮罩和面板是兄弟节点，遮罩点一下或 Esc 关闭。
- 字号、行高、宽度一律用 token；`12`、`24`、`260` 这类数字只出现在 `theme.go`。
- 面板文案一律 `i18n.T` / `i18n.Tf`，两个 locale 都加。
- 纯图标组件必须给 `Label`（`IconButton` / `IconTabs` 已经内置），否则无障碍树里是空的、测试也点不到。
- 不嵌 webview、不在窗口里跑 HTML：需要浏览器就交给系统默认浏览器（`app.OpenURL`）。
- 面板底部/右侧的留白用 `st.Pad`，不要 `Padding(16)`。

## 测试

- 组件自己的测试：`internal/kit/kit_test.go`（`ui.NewTester` + `tt.Click(标签)` + 断言回调）。
- 面板的测试：`internal/view/shell_test.go`（真实 `app.App` + 临时工作区）。
- 截图：见 [ui.md](ui.md)（`OMO_SCREENSHOTS=1` 重写 `docs/ui/*.png`，`OMO_PREVIEW=<dir>` 写全部 56 张）；
  不带环境变量时该测试直接 skip，所以 `go test ./...` 不会改仓库。
