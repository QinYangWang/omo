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

## 组件与主题规范

- 所有 UI 必须使用 `src/components/ui` 中的 shadcn 组件（`Button`、`Input`、`Textarea`、`Select` 等），不要引入裸的 `<button>`/`<input>`/`<textarea>`/`<select>`。自定义布局（列表项、图标按钮、导航项）用 `Button variant="ghost"` + `className` 覆盖实现。例外仅限无语义化替代的原生控件（颜色选择器 `type="color"`、滑块 `type="range"`）和纯视觉指示器（如会话大纲刻度）。
- 图标统一使用 `@hugeicons/core-free-icons` + `@hugeicons/react`（`<HugeiconsIcon icon={...} />`），不要引入其他图标库；嵌套在 Button 内的图标按钮使用 `nativeButton={false}` + `render={<span />}`。例外：模型 / Provider 品牌图标使用 `@lobehub/icons`（经 `src/components/provider-icon.tsx` 的 `ProviderIcon` / `ProviderAvatar`），渲染在固定品牌色底块上，不使用 CDN 图片。
- 颜色一律使用语义化 CSS 变量（`foreground`、`muted-foreground`、`accent`、`destructive`、`success`、`warning`、`info`、`sidebar-*` 等），禁止硬编码调色板类（`text-red-400`、`bg-emerald-500`）或十六进制色值，保证 Appearance 的主题编辑器（`src/lib/theme.tsx` + `src/lib/theme-tokens.ts`）能统一控制所有样式。
- 新增可定制 token 时同步加入 `themeTokenGroups`。
- 终端等 canvas 表面不支持 CSS 变量，从 `getComputedStyle` 读取后用 `normalizeColorToHex()` 转换。

## Vercel 设计语言

omo 的默认视觉语言参考 Vercel design system，并遵守本项目已有的 shadcn/Base UI 与主题约束：

- 页面使用连续画布，通过间距、对齐和排版表达层级；边框和 surface 只用于真实分组、输入字段、选择状态或状态反馈。
- 正文与标题默认使用 Geist Variable，代码和标识符使用 Geist Mono；正文约 15px、1.7 行高，优先用字体层级而不是颜色建立信息层级。
- 默认主色采用近黑/近白的单色方案，状态色只用于 success、warning、destructive、info 等语义状态；图表使用中性灰阶。
- 默认基础圆角为 0.375rem，控件和浮层使用小圆角；胶囊只保留给真正的圆形控件，如开关、进度条和状态点。
- 禁止装饰性渐变、光晕、blob、纹理、玻璃拟态、装饰阴影、全大写 eyebrow、卡片套卡片，以及用边框弥补弱层级。
- Input、Textarea、Select、Dialog、Card、Tooltip、Dropdown、Popover 等共享小圆角、语义边框和明确的 focus ring；列表优先使用整宽 hairline 行。
- Settings 的 Servers、Providers、Models、Skills、Packages 等列表默认去掉卡片盒子；Right Panel 空态使用扁平行，真实工具卡片和 canvas 表面保留各自语义。
- Switch 的轨道、Progress、状态点和会话大纲横线属于视觉语义例外，可以使用圆形或 hairline 形状，但颜色仍来自语义 token。

主题编辑器必须能够覆盖所有业务颜色、圆角和可定制 token；新增 token 时同步加入 `themeTokenGroups`。终端、编辑器和 webview 等 canvas 表面从 CSS 变量读取颜色后转换为运行时需要的格式。

## 应用壳

`src/App.tsx` 使用三列布局：

1. Sidebar：新会话入口、Project、Session、置顶/归档和设置。
2. Main：标题栏、会话流、模型选择器和 Prompt Input。
3. Right Panel：Browser、Terminal、Files 和 Review。

左右边界 Divider 支持鼠标拖拽。Sidebar 宽度范围为 180–400px，Right Panel 宽度范围为 280–640px。

## 启动开屏

`index.html` 内联了一个 canvas 开屏动画（Electron 与 Web 均生效）：移植自 pi 安装脚本（`https://pi.dev/install.ps1`）的 `Show-PiLogoAnimation`——三个 tetromino 下落拼成 π logo，底行闪烁消除后定格并闪烁白色，全程约 2.5s。帧序列与单元格颜色逻辑与原脚本一致；颜色使用 ANSI 近似色，白帧跟随主题前景，底色跟随主题（`.dark` class，此阶段 `index.css` 尚未加载，读不到语义化 CSS 变量）。React `bootstrap()` 渲染完成后调用 `window.omoSplashDone()`，动画播满整条时间轴后淡出并移除节点；启动较慢时停在白色 π 定格帧等待。改动开屏时同步修改 `src/main.tsx` 中的 `omoSplashDone` 调用。

## 标题栏导航

侧栏顶部为 h-10 标题栏（40px，与 Windows 窗口控制按钮同高）：收缩/展开侧栏按钮 + “omo” 产品名，按钮图标与下方 Sidebar 内容左对齐。

会话标题栏左侧显示当前项目名（有会话标题时以“项目 · 标题”追加），横贯右侧 Right Panel 顶部；右侧面板开关悬浮在会话区右上角。

侧栏收起时，侧栏和分隔线完全消失，收缩按钮移动到会话标题栏左侧。

macOS 通过 `titlebar-area-x` 预留交通灯按钮区域。其他平台使用 `titlebar-area-width` 动态避开右侧窗口控制键。交互按钮使用 `WebkitAppRegion: no-drag`。

设置页复用同一组侧栏导航按钮，并支持完全收起设置侧栏。

## 会话区

ChatView 使用 `src/components/chat` 中的 TurnCard 和 RenderBlocks。消息流基于 React Virtuoso 的可变高度虚拟列表；Codex 风格会话大纲直接基于 TurnMeta，不依赖 DOM。节点刻度最多显示 24 条，默认是等宽短线，hover 时变长并显示用户消息预览；点击或在刻度区域滚轮时跳转到对应 Turn，visible range 更新 active 节点。

新任务分为两个明确状态：

- 未选择项目时使用 shadcn `Empty` 作为启动态：图标方块 + 大号欢迎标题（`task_welcome`），下方是最多 5 个现有项目的卡片式快捷入口与“添加项目”操作。此时不渲染 Prompt Composer，避免产生可以输入但无法执行的假可用状态。
- 已选择项目但尚未发送消息时，空态显示欢迎标题与当前项目，欢迎区和 Prompt Composer 集中在同一视觉区域（`max-w-2xl` 居中）；标题为空字符串时，标题栏回退为“新任务”。

Prompt Composer 使用 AICSS `AI Agent Input` registry 的比例，但业务状态仍由 ChatView 控制：正文约 14px / 22px，输入区自然增高且最大高度为 160px；外壳使用 20px 圆角、轻量 hairline 和低对比阴影，底部操作使用 28px 控件。项目、运行模式和分支属于输入前上下文；模型、Thinking、附件和提交操作位于输入区内。未选择项目时不渲染 Composer。

Markdown 使用 React Markdown AST、shadcn/typeset 与 AICSS `TextResponse` 渲染，代码、表格、链接和行内代码仍由 typeset 统一控制，不使用独立的 CodeBlock 卡片组件。AICSS `ThinkingReasoning` 接收真实 Pi reasoning block：运行时保持展开并显示动态状态，完成后自动收起且允许用户重新展开。两个 registry 组件均已改为使用项目语义 token、Geist 字体、shadcn Button 和中英文 i18n，不保留演示数据或硬编码色值。助手回答底部提供时间和复制按钮；复制在非安全上下文浏览器中会回退到隐藏 textarea + `execCommand("copy")`。

工具栏包含：

- 模型选择
- Thinking 等级
- 上下文选择
- Local/Worktree 模式
- 当前分支
- Project 选择

Prompt 输入框基于 AICSS `AI Agent Input` registry 原版视觉重构为受控的 shadcn `InputGroup` 组合：使用 20px 圆角、轻量 hairline 与低对比阴影，输入正文采用 14px / 22px 排版，底部操作使用 28px 圆形按钮。项目、运行模式和分支位于卡片外的上下文行；模型与 Thinking 使用同一套 28px 胶囊控件，统一背景、圆角、hover、focus 与展开状态，并与附件、提交动作共同位于卡片内的底部操作区。Thinking 的显示名称使用本地化产品文案，提交值继续保持 Pi Agent 原始枚举。registry 示例中的演示模型、假技能、模拟“增强提示词”请求和自维护状态不会进入业务组件。

Prompt 输入框保留图片粘贴、`@` 文件补全和 `/` 命令补全；AICSS 原版“＋”菜单提供图片选择与工作区文件入口，工作区文件入口通过插入 `@` 复用真实补全流程。`@` 补全插入的 `@path` 即会话里的文件引用：提交时文本文件不再读取内容内联到 prompt（不生成 `<file>…内容…</file>`），而是把 `@path` 原样作为引用地址，由 agent 用自己的文件工具（`read`/`grep` 等）自行读取；只有图片附件才在提交时读回内容并以 image 附件传给模型。`@` 与 `/` 补全窗使用和输入框一致的 AICSS 弹层语言：不透明 `popover` 背景、10px 外圆角、7px 选项圆角、3px 内边距、紧凑行高与低对比层叠阴影，同时保留方向键、Enter/Tab 和 Esc 键盘行为。命令项只展示 `/命令名`，不显示前置斜杠图标；命令说明通过 hover 或键盘聚焦 Tooltip 展示。`InputGroupTextarea` 必须先于 block addon 出现在 DOM 中，以保持 shadcn 的焦点管理与键盘语义。

模型按 Provider 分组；Provider 标题可点击展开或收起。切换模型时若当前思考强度超出新模型的 `thinkingLevels` 支持范围，自动降为该模型支持的最高档位（并同步 `pi.setThinking`），避免选择器丢选中。模型选择弹层使用不透明 `popover` 背景，宽度限制为 `min(14.375rem, 视口可用宽度)`，相较上一版增加 25%，最大高度不超过 `min(17.5rem, 47vh)`；默认展开当前模型所属 Provider，搜索时展开匹配分组。外框使用 10px 圆角，搜索框按 3px inset 使用同心的 7px 圆角。搜索框固定在弹层顶部，通过分割线与 Provider 列表分区，只有搜索框下方的 Provider 与模型列表滚动；关闭或完成选择后清空搜索。模型行不重复显示 Provider 图标，Provider 标题负责表达分组归属；超长模型名显示省略号，并通过原生 `title` 在 hover 时展示完整名称。Trigger 始终显示会话当前生效的模型（来自 `pi.open` 返回的会话模型）：当该模型不在已启用列表中时，选择器合成一个兜底条目如实显示，而不是回落到占位符；Provider 图标以 14px 品牌色底块显示在模型名前。

Prompt 输入框整体宽度与消息正文一致（`mx-auto max-w-3xl`），不铺满整列；上下文行的 Project 选择器与其他胶囊控件一样向上展开。侧栏会话行的标题必须显式 `text-left`：行容器是原生 `<button>`，UA 默认 `text-align: center` 会让短标题居中错位。

## Sidebar 信息密度

- 每个项目默认显示前 5 条会话；更多会话通过“查看全部 / 收起会话”切换。
- 当前会话始终可见，即使它不在默认的前 5 条中。
- 顶部入口按钮与项目行、会话行左侧对齐（icon 对齐 PROJECTS 标题，会话名文字保持缩进，但 hover/选中背景与项目行左缘对齐）。
- “导入会话”与项目行“新会话”按钮只在 hover 或键盘聚焦时显示；PROJECTS 行的添加按钮常显但保持低对比。
- 会话标题保持单行省略，完整内容通过原生 title 提示查看；置顶/归档按钮以绝对定位浮在标题上方，不压缩标题宽度，只在 hover/聚焦时淡入（无叠加底色）。hover 时标题收缩到按钮组左侧，超出部分以 marquee 动画来回滚动展示（`--marquee-dist` 由 hover 时实测溢出宽度计算）。置顶行的置顶按钮固定在行左侧（实心图标，点击取消置顶），置顶时不显示归档按钮；归档按钮只在 hover/聚焦时出现，选中态也不例外。
- 置顶会话固定在项目内最前，按创建时间从新到旧排序；归档会话从侧边栏隐藏，可在设置「已归档」恢复。

## 右侧面板

`RightPanel.tsx` 使用 Tabs 管理四个 surface：

- Browser：Electron 的 `<webview>`
- Terminal：xterm.js
- Files：目录树和文本预览
- Review：Git status 与 diff

右侧面板的关闭/打开由悬浮在会话区右上角的 PanelRight 按钮控制。Tabs 内容区不提供独立关闭按钮。

## 样式与主题

- i18n 使用 `src/lib/i18n.tsx`，支持 zh/en。
- 主题使用 `src/lib/theme.tsx`，支持 dark、light 和 system。
- 主题初始化脚本位于 `index.html`，避免启动闪烁。
- 业务组件使用语义 CSS 变量。
- 常用色板包括 `bg-background`、`bg-sidebar`、`bg-panel`、`bg-surface`、`bg-card`、`text-muted-foreground` 和 `border-border`。
- Progress 使用者自行组合 Track 和 Indicator；根组件不会隐式追加第二条轨道。
