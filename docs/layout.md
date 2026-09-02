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

Project 对应本地或远程执行端目录。Session 条目显示名称或首条消息。

## Chat

空态显示会话标题和 Prompt Input。

会话中从上到下：

- 标题栏：导航、当前 Session 标题、Info、Right Panel 开关
- Conversation：历史消息和流式增量
- Prompt Input：输入、模型、Thinking、上下文、Local/Worktree、分支和 Project

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

- General
- Appearance
- Providers
- Skills
- Usage
- Packages

General 当前实现 Server URL、Token、连接测试和本地/远程切换。Appearance 实现主题和语言。Providers 使用 Pi Provider 认证和配额。Usage 使用 Session JSONL 聚合。Skills 与 Packages 使用当前应用内的展示数据。

设置页 Sidebar 可以收起，收起后顶部导航按钮移动到设置内容区。
