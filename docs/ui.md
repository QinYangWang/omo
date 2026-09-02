# UI 组件与界面结构

## 组件栈

项目使用 `src/components/ui` 中的 shadcn/ui 组件。`components.json` 使用 `base-rhea`，底层组件为 Base UI。

新增 UI 组件：

```bash
npx shadcn@latest add <component>
```

Base UI 约定：

- 自定义 trigger 使用 `render` prop。
- 不使用 Radix 的 `asChild`。
- Select 使用 items-first 和对象值模式。
- Trigger、Label 等部件可以接收 `render={<element />}` 替换默认元素。

## ai-elements

聊天组件保留在：

```text
src/components/ai-elements/
  conversation.tsx
  message.tsx
  prompt-input.tsx
```

这些组件复用 `src/components/ui` 的 Button、Input Group、Select、Tooltip、Dropdown Menu 等实现。

## 应用壳

`src/App.tsx` 使用三列布局：

1. Sidebar：搜索、Project、Session、导入和设置。
2. Main：标题栏、会话流、模型选择器和 Prompt Input。
3. Right Panel：Browser、Terminal、Files 和 Review。

左右边界 Divider 支持鼠标拖拽。Sidebar 宽度范围为 180–400px，Right Panel 宽度范围为 280–640px。

## 标题栏导航

侧栏顶部没有应用名称文字，使用三个按钮：

- 收缩/展开侧栏
- 上一 Session
- 下一 Session

按钮根据已加载 Session 顺序切换。侧栏收起时，侧栏和分隔线完全消失，三个按钮移动到会话标题栏左侧。

macOS 通过 `titlebar-area-x` 预留交通灯按钮区域。其他平台使用 `titlebar-area-width` 动态避开右侧窗口控制键。交互按钮使用 `WebkitAppRegion: no-drag`。

设置页复用同一组侧栏导航按钮，并支持完全收起设置侧栏。

## 会话区

ChatView 使用 ai-elements 的 Conversation、Message 和 PromptInput。工具栏包含：

- 模型选择
- Thinking 等级
- 上下文选择
- Local/Worktree 模式
- 当前分支
- Project 选择

模型按 Provider 分组；Provider 标题可点击展开或收起。

## 右侧面板

`RightPanel.tsx` 使用 Tabs 管理四个 surface：

- Browser：Electron 的 `<webview>`
- Terminal：xterm.js
- Files：目录树和文本预览
- Review：Git status 与 diff

右侧面板的关闭/打开由会话标题栏右侧的 PanelRight 按钮控制。Tabs 内容区不提供独立关闭按钮。

## 样式与主题

- i18n 使用 `src/lib/i18n.tsx`，支持 zh/en。
- 主题使用 `src/lib/theme.tsx`，支持 dark、light 和 system。
- 主题初始化脚本位于 `index.html`，避免启动闪烁。
- 业务组件使用语义 CSS 变量。
- 常用色板包括 `bg-background`、`bg-sidebar`、`bg-panel`、`bg-surface`、`bg-card`、`text-muted-foreground` 和 `border-border`。
