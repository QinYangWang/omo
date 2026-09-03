# 页面布局

## App Shell

应用使用三列布局：

```text
┌──────────┬──────────────────────────┬──────────────┐
│ Sidebar  │ Chat / Settings          │ Right Panel  │
└──────────┴──────────────────────────┴──────────────┘
```

两列之间的 1px 分隔线支持拖拽。Sidebar 宽度为 180–400px，Right Panel 宽度为 280–640px。

Sidebar 展开时顶部使用三个无拖拽按钮：

```text
[侧栏] [← 会话] [→ 会话]
```

macOS 按钮位于窗口交通灯右侧；Windows 根据 `titlebar-area-*` 预留右侧窗口按钮区域。

Sidebar 收起后完全隐藏，三个按钮移动到会话标题栏左侧。

## Sidebar

从上到下：

- 搜索按钮
- PROJECTS 标题和添加按钮
- Project 分组
- 每个 Project 下的 Session 列表
- Session 导入和新建按钮
- 底部设置入口

Project 对应本地或远程执行端目录。添加项目通过目录选择完成：Electron 本地模式使用系统目录选择器，远程模式使用 Server workspace 目录树；纯静态 Web 不提供本地目录选择。

Session 条目显示名称或首条消息。创建 Project 后不自动导入 Session；导入按钮只列出当前 Project cwd 下的 Pi Session。

## Chat

空态显示会话标题和 Prompt Input。

会话中从上到下：

- 标题栏：导航、当前 Session 标题、Info、Right Panel 开关
- Conversation：历史消息和流式增量
- Prompt Input：输入、模型、Thinking、上下文、Local/Worktree、分支和 Project；默认 placeholder 会提示粘贴图片、`@` 文件和 `/` 命令

Project 选择器包含已有 Project、New project 和 no project。模型选择器按 Provider 分组，并支持展开/收起。

## Right Panel

Tab：

- Browser
- Terminal
- Files
- Review

Browser 在 Electron 中使用 `<webview>`。Terminal 使用 xterm.js；远程模式连接服务器 PTY。Files 显示目录树和文本。Review 显示 Git status，并可选择文件查看 diff。

## Settings

Settings 是全屏视图，左侧导航包含：

- Appearance
- Servers
- Providers
- Models
- Skills
- Usage
- Packages

Servers 管理本机连接与多个远程服务器（添加/编辑/删除、状态监测）。Appearance 实现主题模式、语言和自定义主题编辑器：逐项覆盖 shadcn / typeset CSS 变量（颜色用调色盘、数值用滑块），可粘贴完整主题 CSS 一键导入，也可导出为自定义主题。Providers 使用 Pi Provider 认证；Models 通过 pi `enabledModels` 筛选可用模型；Skills 与 Packages 展示真实的 agent 技能和 pi 扩展包。Usage 使用 Session JSONL 聚合，按服务器分组展示多语言统计和订阅配额进度。Usage 不显示上下文使用分析。Providers、Models、Skills、Packages 在多服务器时可切换目标服务器。

设置页内容居中（`mx-auto max-w-3xl`），侧栏导航项带图标。设置页 Sidebar 可以收起，收起后顶部导航按钮移动到设置内容区。
