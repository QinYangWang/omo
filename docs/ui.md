# UI：截图、当前布局与改造记录

视觉规则（token、颜色语义、反模式）在 **[DESIGN.md](../DESIGN.md)**；本文说当前布局和截图。
设计源：Doop 画布 `C73kBnDHCY`（omo-app-style v2，28 个界面 × 深/浅），原型
<https://doop.qinyang.wang/c/C73kBnDHCY/proto>。

## 截图

`docs/ui/*.png` 全部**由代码生成**：同一个 demo 项目（`paneui`，带 git 历史）、同一组 Agent
（Claude Code / Codex / Gemini CLI / Pi，指向假的可执行文件，信任前不会启动任何进程）、同一段回放的 ACP 会话
（`App.Replay`：计划、工具调用、权限请求、失败）。窗口 1280×800，界面语言 zh-Hans，帧号与 Doop 帧一致。

```sh
# 重写 docs/ui：28 个界面深色 + 6 个主要界面浅色
OMO_SCREENSHOTS=1 OMO_PREVIEW_CJK=/path/to/NotoSansSC.otf go test ./internal/view -run TestWriteScreenshots

# 全部 56 张（深/浅），按 Doop 帧名命名（home-dark.png …），方便和设计并排比对
OMO_PREVIEW=/tmp/omo-preview OMO_PREVIEW_CJK=/path/to/NotoSansSC.otf go test ./internal/view -run TestWriteScreenshots
```

- 生成器：`internal/view/screenshots_test.go`（`shotScreens` 列出 28 个界面和它们的准备步骤）。
- `OMO_PREVIEW_CJK` 只给没有中文字体的机器（Linux 容器）用：不注册的话中文画不出来。Windows/macOS 用系统字体。
- 不带 `OMO_SCREENSHOTS` / `OMO_PREVIEW` 时该测试直接 skip，所以 `go test ./...` 不会改仓库。
- demo 项目落在 `<系统临时目录>/omo-ui-screenshots`，路径固定，所以同一台机器重跑结果稳定。

| 帧 | 文件 | 状态 | 浅色 |
|---|---|---|---|
| 01 | `01-home-dark.png` | 新会话：项目/分支芯片、问题、输入框、快捷指令、最近会话 | ✓ |
| 01b | `01b-picker-dark.png` | Agent 选择：本机 ACP Agent 与进程状态、会话模式 |  |
| 02 | `02-sess-dark.png` | 会话已完成：对话列 + 检查器（计划、本会话、改动） | ✓ |
| 02b | `02b-term-dark.png` | 侧面板 · 终端（headless 下是空状态：不创建 PTY） |  |
| 03 | `03-files-dark.png` | 侧面板 · 文件：树 + 预览 |  |
| 04 | `04-diff-dark.png` | 侧面板 · 变更：文件列表、diff、提交框 | ✓ |
| 05 | `05-palette-dark.png` | 搜索：会话 / 文件 / 命令 |  |
| 05b | `05b-palette0-dark.png` | 搜索无结果：交给 Agent |  |
| 06 | `06-sched-dark.png` | 定时任务：筛选、表格、详情 |  |
| 06b | `06b-sched_new-dark.png` | 新建定时任务浮层 |  |
| 07 | `07-set_pref-dark.png` | 设置 · 偏好设置 |  |
| 08 | `08-set_appear-dark.png` | 设置 · 外观 |  |
| 09 | `09-set_keys-dark.png` | 设置 · 快捷键 |  |
| 10 | `10-set_general-dark.png` | 设置 · 通用 |  |
| 11 | `11-set_usage-dark.png` | 设置 · AI 用量（空状态） |  |
| 12 | `12-set_agents-dark.png` | 设置 · Agents | ✓ |
| 13 | `13-set_projects-dark.png` | 设置 · 项目 |  |
| 14 | `14-set_mcp-dark.png` | 设置 · MCP（空状态 + 规则） |  |
| 15 | `15-set_prompts-dark.png` | 设置 · 快捷指令 |  |
| 16 | `16-run-dark.png` | 权限请求：琥珀卡片，允许一次 / 本会话内始终允许 / 拒绝 | ✓ |
| 17 | `17-trust-dark.png` | 首次信任 Agent |  |
| 18 | `18-running-dark.png` | Agent 运行中：停止按钮、计时 |  |
| 19 | `19-error-dark.png` | Agent 启动失败：原因、进程输出、三种修复 | ✓ |
| 20 | `20-set_roles-dark.png` | 设置 · Agent 角色（空状态） |  |
| 21 | `21-set_memory-dark.png` | 设置 · 记忆 |  |
| 22 | `22-set_github-dark.png` | 设置 · GitHub |  |
| 23 | `23-set_share-dark.png` | 设置 · 分享 |  |
| 24 | `24-set_about-dark.png` | 设置 · 关于 omo |  |


## 当前布局：本地 Agent 控制台（2026-11，Doop 重设计）

- **侧栏 252**（`view/shell.go`）：omo 字标 → 新会话 `Ctrl+N` / 搜索 `Ctrl+K` / 定时任务 → 项目（当前项目带分支，
  下面挂它的会话：Agent 标识 + 标题 + 状态，转圈=运行中、琥珀“待批准”、红点=失败、时间=已结束；其它最近项目点一下就打开）
  → 本机 Agent（每个 ACP Agent 的进程状态：1 会话 / 空闲 / 启动中 / 未启动 / 启动失败，点一下到 设置 → Agents）
  → 底部用户、设置、深浅切换。
- **新会话**（`view/home.go`）：项目/分支芯片、问题、输入框（@ 引用、Agent 芯片打开选择器、发送）、快捷指令芯片
  （点一下把内容放进输入框）、最近会话卡片。
- **会话**（`view/session.go`）：48 DIP 标题栏（标题、Agent 芯片、状态标签、计划、`+N −N`、终端、文件）；
  对话列（用户气泡、Agent 文本里的 `code`、工具卡：连续读取/搜索折叠成一行、行内琥珀权限卡、红色错误卡）；
  输入框（运行中是反色停止钮）与状态行（目录、分支、工具调用数）。
- **检查器 300**（`view/inspector.go`）：ACP 计划（完成划线 / 进行中钴蓝淡底 / 等批准琥珀 / 待办）、本会话
  （Agent 与进程状态、模式、工具调用、MCP）、改动（按状态着色）、“查看全部改动”。
- **侧面板 520**：变更（Agent 改过的文件 + `+N/−N` + 状态字母、选中文件的 diff、提交信息 + 全部回退/全部保留/提交）、
  文件（树 + 预览/编辑）、终端（最多 4 个）。
- **浮层**（`view/overlays.go`）：搜索、Agent 选择、首次信任、Agent 配置、磁盘冲突、新建定时任务；纯色遮罩，Esc 关闭。
- **定时任务**（`view/schedule.go`）与 **设置**（`view/settings.go`，整窗，236 导航 + 720/900 内容）。

外观跟随 设置 → 外观（浅色 / 深色 / 跟随系统），侧栏底部的太阳/月亮直接切到另一套。
后端还没有的部分（用量、MCP 列表、角色、记忆、分享、定时任务的调度器、模型列表）画成真实的空状态，
清单在 [roadmap.md](roadmap.md) §9.6。

### 真实窗口截图

真实窗口 + 真终端（headless 跑不了 PTY）用 `internal/app/capture.go` 的截图模式，
默认关闭：

```sh
CGO_ENABLED=0 go build -trimpath -o build/omo.exe .

OMO_SCREENSHOT=/tmp/shot.png \
OMO_SCREENSHOT_WORKSPACE=$PWD \
OMO_SCREENSHOT_OPEN=main.go,internal/view/shell.go \
OMO_SCREENSHOT_TERMINAL=1 OMO_SCREENSHOT_MS=2600 ./build/omo.exe
```

环境变量：`OMO_SCREENSHOT`（输出路径）、`OMO_SCREENSHOT_WORKSPACE`、
`OMO_SCREENSHOT_OPEN`（逗号分隔的相对路径）、`OMO_SCREENSHOT_DIFF`、
`OMO_SCREENSHOT_TERMINAL`、`OMO_SCREENSHOT_MS`（等待帧/终端就绪）。
这类截图是页面区域：窗口按钮叠在右上角，所以图里看不到，但顶栏用 `c.TitleBar()`
给它留了位置。

## 历史：会话优先的三栏（2026-10，被 Doop 重设计取代）

布局按「项目与会话在左、会话在中间、项目内容在右」重排，不再有活动栏：

- **顶栏**：左边是会话列表的收起/展开图标 + `omo` 标志 + 打开的工作区；右边只剩底部面板与
  右侧栏两个开关。顶栏不再画 File / View 菜单（原生菜单栏仍在，由 `a.Menu()` 构建）。
- **左侧栏 `sessionsPanel`**：项目与会话总览。顶部是筛选框；下面是项目行（分支或改动数，
  点一下把右侧栏切回「文件」）、已打开的文件/差异审查标签页、终端会话。点行即回到对应的
  标签页或终端，所以这一栏是「回到任何东西」的入口。
- **中间 `sessionPane`**：标签条第一个标签是会话（标题 `omo`），从任何文件都能点回来；
  没有标签页时中间就是 ACP 会话窗口：Agent 选择/启动/重启、流式文本与思考、工具活动、计划、
  输入框和取消按钮。权限审批、首次信任与 Agent 配置使用原生 Modal；启动时在 `PATH` 上找到的
  已知 Agent（Codex / Claude Code / Pi，见 `internal/agent/presets.go`）自动进入「Agents…」列表，
  仍是未信任状态，列表里还能「更新 CLI」（在终端里跑该包的 `npm install --global …@latest`）。
  打开文件后是标签条 + 编辑器/差异审查，底部面板仍在这一列下方。
- **右侧栏 `rightSidebar`**：标头是一排图标（`kit.IconTabs`），依次是文件、搜索、改动（git）、
  运行和调试、浏览器。文件/搜索/改动看的是当前项目的内容；改动页的 `+` 把工作区里的每一条
  改动 `git add` 进索引（只暂存工作区内的路径，不会波及上级仓库），暂存后的状态字母用成功色；
  「运行和调试」按项目根目录的
  标记文件给出快捷指令（`go.mod` → Build/Test/Vet，`Makefile` → make），每条在项目根目录的
  新终端里跑；「浏览器」把地址交给系统默认浏览器（`mygo.Shell.OpenExternal`），不在窗口里嵌
  webview。「改动」页顶部在 Agent 改过文件时多一行「Agent 改动（N）+ 审查」，点进去是审查列表。
- **审查列表（`TabReview`）**：Agent 碰过的文件，每行带 `+N −M`，点行进单文件 diff；表头有
  「全部保留 / 全部回退」。审查基准是 Agent 动手前的文本（`internal/app/review.go`），与 git HEAD
  无关，所以脏工作区也能审查。截图 `13-agent-review-dark.png` 用 `App.NoteAgentPaths` 在写真之前
  抓基准，然后真写文件，和 Agent 自己的写入行为一致。
- **底部面板**：终端页最多同时开 4 个会话，再开一个时状态栏提示先关闭一个；关闭工作区
  或退出应用时挂断 shell 并等它退出。终端视图在面板里必须用 `Fill()`：`ui.Row(...).Grow(1)`
  里的盒子只有宽度，没有可命中的高度，终端会照常绘制、内容还会跑到面板中间，但点不到、
  也拿不到键盘（历史 bug）。
- 活动栏（46 DIP 图标条）和右侧 Chat 面板都去掉了：前者变成右侧栏的图标标头，后者变成中间
  的会话窗口。

仍是占位：搜索页还没有工作区搜索。ACP 当前是一个工作区一个活跃 Agent/Session；
会话元数据（Workspace、标签页布局、`acp_session` 映射）已在 P3 落进本地 SQLite 并在启动时恢复。

## 视觉层：`internal/kit`

颜色、字号、间距和可复用组件都在 `internal/kit`（思路同 shadcn/ui）：面板只负责组合，
不写颜色字面量。组件、token、扩展配方和踩过的坑见 **[kit.md](kit.md)**。

## 历史：上一轮（标题栏 + 调色板）

> 这一节的 File / View 顶栏菜单、右侧 Chat 面板在「会话优先的三栏」里已被删掉/取代，留作记录。

### 沉浸式标题栏与菜单

- `main.go` 用 `mygo.TitleBarHidden` 和 `TitleBarHeight: 38` 把系统标题栏让给内容；
  顶栏就是标题栏：图标 + `omo` + `File` / `View` + 工作区名 + 面板开关。
- `c.TitleBar()` 的左右内边距给 Windows/Linux 的窗口按钮留位，整行 `DragWindow()`
  可拖动；窗口控制按钮叠在顶栏右端。
- 隐藏标题栏后 Windows/Linux 的原生菜单栏不再显示，当时用 `App.UIMenu` 把原生菜单项
  映射成 `ui.Menu` 画在顶栏里，快捷键也显示在菜单项右侧。（顶栏菜单后来删了，`UIMenu`
  随之删除；原生菜单栏仍由 `App.Menu()` 构建。）
- Edit 的撤销/复制/粘贴是 MyGo 的 role，作用在焦点元素上，应用自己画的菜单调不到，
  所以仍用快捷键和右键菜单；原生菜单也可用 Alt/F10 弹出。

### 调色板

- palette 现在在 `internal/kit/theme.go`，取自 Vercel Geist 尺度：暗色 chrome `#000`、内容 `#0a0a0a`
  控件面 `#1a1a1a`、强调蓝 `#47a8ff`；浅色是白底 + `#fafafa` chrome + `#006bff` 蓝，见 [DESIGN.md](../DESIGN.md)。
- `kit.New(c)` 每帧把 palette 写进 `c.SetTheme`，所以按钮、输入框、滚动条和编辑器
  跟 chrome 用同一套颜色，不再各自取默认主题（终端仍用它的明暗两套配色）。
- 实心按钮用**对比**而不是色相：暗色窗口白底黑字，浅色窗口黑底白字。
- 代码配色也来自同一套色（`kit.Theme.EditorTheme`）：关键词蓝、字符串/类型绿、数字/属性瑰珀、
  标签红、注释灰，明暗各一套。

### 布局与外壳

- 文件树：展开箭头、文件夹图标、按扩展名着色的文件图标、右侧的未保存圆点，
  当前文件行高亮。
- 标签条：文件类型图标 + 文件名 + `×`；激活标签用编辑器底色和 1 DIP 边框浮起来。
  下面加一行面包屑（`internal > view > shell.go`）。
- 底部面板：Terminal / Problems / Output 带图标，右侧 `+`、垃圾桶、收起三个动作；
  终端内容留 6 DIP 边距，像面板里的一张卡片。
- 状态栏：分支图标 + 改动数（警告色）+ 提示；右侧保留光标、缩进、编码、换行、语言，
  `Panel` / `Sidebar` 是可点亮的薄片。
- 空状态：欢迎页是标志 + 大字 + `START` 分组 + 带快捷键的动作行。

## 历史：P1 收尾

### 截图暴露的三个真 bug（都已修）

1. **非输入事件不重绘**：菜单命令、watcher 事件、应用 diff 之后状态变了但界面不刷新。
   加 `App.invalidate()`（`Window.Invalidate()`），`Dispatch` 与 `Run` 结束时调用。
2. **1 DIP 分隔线铺满整块**：`ui.Box(...).Height(1).Fill()` 里 `Fill` 是**两个方向**都填满，
   于是这条线变成一块和父容器一样大的边框色矩形，盖住并挡住下面所有内容
   （侧栏文件树点不动就是它）。改成 `.FillWidth()`。
3. **嵌套的 `OnClick` 收不到点击**：标签页上的关闭按钮嵌在可点击的标签里时点击无效，
   把关闭按钮改成标签的**兄弟**节点。

### 布局

- 底部面板关闭时**不再占位**：主区域 100%，编辑器下方不再有白带。
- 终端视图铺满面板；编辑区字号固定 13 DIP、行高 1.5（编辑器默认偏大）。
- 无标签页时**不画空的标签条**（一个空的控件看起来像坏了）。

## 仍然粗糙的地方（三栏时期，留作记录）

1. ACP 已接入中央会话窗口，但还没有多 Agent 并行与持久化 transcript；左侧「会话」目前列的是标签页和终端。
2. 搜索页仍是占位（没有工作区搜索）。
3. 两侧栏宽度固定，不能拖拽；窗口很窄时中间会被挤。
4. 终端配色跟随窗口主题，但没做独立的终端主题（例如浅色 IDE + 深色终端）。
5. 光标/选中在状态栏的布局：`Ln/Col` 与编码等挤在右侧，信息密度还可以再优化。
6. 文件树还没有缩进引导线；动效（hover 过渡、面板开合）都没有，先不引入以保持零空闲 CPU。
