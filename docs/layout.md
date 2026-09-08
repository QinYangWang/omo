# 页面布局

## App Shell

应用是 Sidebar + Conversation + Workspace 三栏工作台：

```text
┌──────────────── 顶栏（h-10，与 Sidebar 一体的 --sidebar 色，无文字） ────────────────┐
│ Sidebar ║ Conversation ║ Workspace                                                 │
│ 310px   ║ 460px        ║ Tabs + [ Main | Explorer(clamp 240~300px) ]               │
└──────────╨──────────────╨───────────────────────────────────────────────────────────┘
```

Sidebar 默认 310px（可拖 240–400），Conversation 默认 460px（可拖 380–560），Workspace 占剩余全部。两个宽度持久化到 localStorage（`omo.layout.sidebarW` / `omo.layout.convW`）。拖拽 Divider 使用 pointer events。

Sidebar 收起后完全隐藏，收缩按钮留在顶栏左侧。

macOS 按钮位于窗口交通灯右侧；Windows 根据 `titlebar-area-*` 预留右侧窗口按钮区域，原生窗口按钮背景色经 `setTitleBarOverlay` 跟随顶栏的 `--sidebar`（经 `normalizeColorToHex` 转换）。

## Conversation

Conversation Pane 从上到下：Conversation Header（h-12，folder 图标 + 会话标题单行 ellipsis，右侧是 Workspace 抽屉开关，与 Sidebar 交界处 `rounded-tl-lg` 圆角）→ 消息区（Virtuoso 自滚动）→ Composer（固定底部，`px-4 pb-3`，不再二次居中限宽）。无会话时首页/项目选择作为 Conversation 的 empty state 呈现，项目列表为紧凑行而非大卡片。Workspace 收起时 Conversation 自适应占满剩余宽度。

## Workspace

Workspace 默认收起，通过会话名栏右侧的抽屉开关打开（打开后 Conversation 固定 460px 可拖，Workspace 占剩余空间）。结构为 `WorkspaceTabs + Body[Main + Explorer]`：

- WorkspaceTabs（h-12，与会话名栏同高）：shadcn Tabs 默认 variant 圆角 button 标签——固定的“变更”标签 + 文档标签（文件/diff，可关闭）+ “+”菜单（可添加多个浏览器、终端标签页）。所有标签内容保持挂载（hidden 切换），终端与浏览器状态不丢失。
- WorkspaceMain：当前标签内容——Changes 列表、文件预览、diff（`@pierre/diffs` 的 `File`/`PatchDiff`）、终端、浏览器。
- FileExplorer（右侧辅助栏，宽 `clamp(240px, 19vw, 300px)`）：搜索框（过滤已加载节点）+ 可折叠文件树（28px 行高、13px 字号），点击文件在 Main 中打开文档标签，active 文件高亮。

## Sidebar

从上到下：

- 新会话按钮（卡片式描边按钮，作用于当前项目，无活动项目时取第一个项目）
- PROJECTS 标题；添加按钮常显但低对比，hover 时增强
- Project 分组
- 每个 Project 下的 Session 列表
- Session 导入和新建按钮（悬停项目行时显示）
- 底部设置入口（分隔线上方带图标的整行按钮）

Project 对应本地或远程执行端目录。添加项目通过目录选择完成：Electron 本地模式使用系统目录选择器，远程模式使用 Server workspace 目录树；纯静态 Web 不提供本地目录选择。

Session 条目显示名称或首条消息。创建 Project 后不自动导入 Session；导入按钮只列出当前 Project cwd 下的 Pi Session。

会话行左侧固定位置是置顶/取消置顶按钮；右侧悬停区同一位置显示进行中 Spinner 或 `MoreHorizontalCircle02Icon` 操作菜单（重命名、克隆、复制上下文、归档），不挤压标题文字。会话名 hover 弹出 HoverCard，显示会话 ID、Git 分支、工作目录类型与累计 cost。克隆通过 `createBranchedSession` 在同一 cwd 下创建新 Session 文件；复制上下文导出当前分支为 Markdown；重命名写入 Session 的 `session_info`。

- 置顶：会话固定在项目列表最前，多个置顶按会话创建时间从新到旧排序。
- 归档：仅从侧边栏隐藏，不影响用量统计；可在设置的「已归档」分区恢复。

置顶与归档状态持久化在 localStorage（`omo:sessionPrefs`，key 为 `serverId:sessionPath`），见 `src/lib/session-prefs.ts`。

## Chat

空态显示会话标题和 Prompt Input。

会话中从上到下：

- 标题栏（h-10）：左侧项目名（有会话标题时以“项目 · 标题”形式跟在后面），右侧留空作为拖拽区；该栏横贯右侧 Right Panel 顶部
- Conversation：历史消息和流式增量；Right Panel 开关悬浮在会话区右上角
- Prompt Input：输入、模型、Thinking、上下文、Local/Worktree、分支和 Project；默认 placeholder 会提示粘贴图片、`@` 文件和 `/` 命令

Project 选择器包含已有 Project、New project 和 no project。模型选择器按 Provider 分组，并支持展开/收起。

## Right Panel

Right Panel 位于会话标题栏下方、会话区右侧，宽度 280–640px。

Tab：

- Browser
- Terminal
- Files
- Review

Browser 在 Electron 中使用 `<webview>`。Terminal 使用 xterm.js；远程模式连接服务器 PTY。Files 显示目录树和文本。Review 显示 Git status，并可选择文件查看 diff。

## Settings

Settings 是全屏视图，左侧导航包含：

- Appearance
- Archived
- Servers
- Providers
- Models
- Skills
- Usage
- Packages

Archived 分区列出所有已归档会话并可恢复到侧边栏。

Servers 管理本机连接与多个远程服务器（添加/编辑/删除、状态监测）。Appearance 实现主题模式、语言和自定义主题编辑器：逐项覆盖 shadcn / typeset CSS 变量（颜色用调色盘、数值用滑块），可粘贴完整主题 CSS 一键导入，也可导出为自定义主题。Providers 使用 Pi Provider 认证；Models 通过 pi `enabledModels` 筛选可用模型；Skills 与 Packages 展示真实的 agent 技能和 pi 扩展包。Usage 使用 Session JSONL 聚合，按服务器分组展示多语言统计和订阅配额进度。Usage 不显示上下文使用分析。Providers、Models、Skills、Packages 在多服务器时可切换目标服务器。

设置页内容居中（`mx-auto max-w-3xl`），侧栏导航项带图标。设置页 Sidebar 可以收起，收起后顶部导航按钮移动到设置内容区。
