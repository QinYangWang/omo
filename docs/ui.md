# UI：现状、截图与改造记录

## 怎么复现截图

两种方式，都是仓库里的代码，不是手工操作。

### 1. 真实窗口（`Window.CapturePage()`）

`internal/app/capture.go` 提供的截图模式，默认关闭：

```sh
CGO_ENABLED=0 go build -trimpath -o build/omo.exe .

# 空状态
OMO_SCREENSHOT=docs/ui/new-01-welcome.png OMO_SCREENSHOT_MS=800 ./build/omo.exe

# 工作区 + 两个文件 + 终端
OMO_SCREENSHOT=docs/ui/new-02-workspace.png \
OMO_SCREENSHOT_WORKSPACE=$PWD \
OMO_SCREENSHOT_OPEN=main.go,internal/view/shell.go \
OMO_SCREENSHOT_TERMINAL=1 OMO_SCREENSHOT_MS=2600 ./build/omo.exe

# Diff 审查（需要一个含改动的 git 仓库）
OMO_SCREENSHOT=docs/ui/new-03-diff.png \
OMO_SCREENSHOT_WORKSPACE=/tmp/demo-repo \
OMO_SCREENSHOT_DIFF=main.go OMO_SCREENSHOT_MS=1200 ./build/omo.exe
```

环境变量：`OMO_SCREENSHOT`（输出路径）、`OMO_SCREENSHOT_WORKSPACE`、
`OMO_SCREENSHOT_OPEN`（逗号分隔的相对路径）、`OMO_SCREENSHOT_DIFF`、
`OMO_SCREENSHOT_TERMINAL`、`OMO_SCREENSHOT_MS`（等待帧/终端就绪）。

### 2. 明暗两套预览（headless `ui.Tester`）

本机是浅色系统，暗色外观靠 `Tester.SetDark(true)` 渲染，不需要改系统设置：

```sh
OMO_PREVIEW_DARK=$PWD/docs/ui/new-04-dark.png \
OMO_PREVIEW_LIGHT=$PWD/docs/ui/new-05-light.png \
go test ./internal/view -run TestWritePreviews
```

（该测试是一次性的：需要时按上面的方式临时生成，不常驻。）

## 截图

| 文件 | 内容 | 来源 |
|---|---|---|
| `docs/ui/current-*.png` | 改造**前**（P1 结束时） | 真实窗口 |
| `docs/ui/new-01-welcome.png` | 改造后：空状态 | 真实窗口 |
| `docs/ui/new-02-workspace.png` | 改造后：工作区 + 编辑器 + 终端 | 真实窗口 |
| `docs/ui/new-03-diff.png` | 改造后：Diff 审查 | 真实窗口 |
| `docs/ui/new-04-dark.png` | 改造后：暗色（跟随系统时的一种外观） | headless |
| `docs/ui/new-05-light.png` | 改造后：浅色 | headless |

## 这一轮改了什么

### 截图暴露的三个真 bug（都已修）

1. **非输入事件不重绘**：菜单命令、watcher 事件、应用 diff 之后状态变了但界面不刷新。
   加 `App.invalidate()`（`Window.Invalidate()`），`Dispatch` 与 `Run` 结束时调用。
   症状最初表现为"截图三张一模一样"。
2. **1 DIP 分隔线铺满整块**：`ui.Box(...).Height(1).Fill()` 里 `Fill` 是**两个方向**都填满，
   于是这条线变成一块和父容器一样大的边框色矩形，盖住并挡住下面所有内容
   （侧栏文件树点不动就是它）。改成 `.FillWidth()`。
3. **嵌套的 `OnClick` 收不到点击**：标签页上的关闭按钮嵌在可点击的标签里时点击无效，
   把关闭按钮改成标签的**兄弟**节点（`Box` + `Justify/AlignItems` + `OnClick`）。

### 视觉系统

- 新增 `internal/view/style.go`：颜色全部来自窗口主题（因此**跟随系统**明暗），
  只补字号（11/12/13）、行高（22/26/32）、间距（6/10）、固定宽度（rail 44 / 侧栏 240）。
- 分层方式从"灰色大块"改为**表面 + 1 DIP 分隔线**：编辑器用 `Background`，
  侧栏/对话/底部面板用 `Surface`，标签条与状态栏用 `Surface`。
  标签条与激活标签在明暗两套下互换深浅（`tabStrip()` / `activeTab()`），
  两种外观下激活标签都从条带里"浮"出来。
- 所有"外壳"改为自绘行/薄片（`rows.go` 的 `row` 与 `chip`）：活动栏图标、
  文件树行、改动列表、终端页签、状态栏分组。`Button` 只留给真正的动作
  （打开工作区、应用审查、冲突对话框）。

### 布局

- 底部面板关闭时**不再占位**：主区域 100%，编辑器下方不再有白带。
- 终端视图铺满面板；编辑区字号固定 13 DIP、行高 1.5（编辑器默认偏大）。
- 无标签页时**不画空的标签条**（一个空的控件看起来像坏了）。

### 右侧 Chat

- 宽度可拖拽（与编辑器之间的分隔条，`Layout.EditorCols` 默认 76%）。
- 可隐藏：面板标题上的 `×`、状态栏的 `Chat`、`View > Toggle Chat`（`CmdOrCtrl+Shift+C`）。
- 空态文字垂直居中，不再是贴顶的三行 + 孤立按钮。

### 其它

- 标签页：每个标签自带 `×`（兄弟节点），激活标签有强调色下划线；diff 标签显示 `± name`。
- Diff 头部：`Diff: path  +N  −M` + 提示 + `Apply review`。
- 侧栏空状态：只有一句说明，不再显示"假的分区标题"。
- 状态栏去掉与文件树重复的工作区名；`Panel` / `Chat` 作为可点亮的薄片。

## 仍然粗糙的地方（下一轮）

1. 文件树没有文件类型图标、没有缩进引导线。
2. Chat 面板还只有空态：等 P2 接 ACP 才有会话列表与输入框。
3. 终端配色跟随窗口主题，但没做独立的终端主题（例如浅色 IDE + 深色终端）。
4. 光标/选中在状态栏的布局：`Ln/Col` 与编码等挤在右侧，信息密度还可以再优化。
5. 窗口没有自定义标题栏（现在用系统标题栏 + 原生菜单）。
6. 动效：hover 过渡、面板开合动画都没有（MyGo 支持动画，先不引入以保持零空闲 CPU）。
