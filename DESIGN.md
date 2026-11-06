# DESIGN.md — omo 的视觉规范

这份文档是**样式裁判**：写 UI 之前读它，改 UI 之后按它自检。
设计源是 Doop 画布 `C73kBnDHCY`（一页 56 帧 = 28 个界面 × 深/浅）和它的风格指南 **omo-app-style v2**；
`internal/kit`（token 与组件）是它的实现，[docs/kit.md](docs/kit.md) 是使用手册，
[docs/ui.md](docs/ui.md) 是当前布局与截图。三者冲突时，以本文为准，并在 kit 里改掉。

## 1. 基调

omo 是本地 Agent 控制台：通过 ACP 启动本机的 Agent 进程，看它们的计划、工具调用和改动，
在需要时批准。**夜里的绘图桌**：石墨底、描图纸般的暖白文字、一支钴蓝墨水笔。
中性灰承担结构，钴蓝是唯一强调色；琥珀只用于“等待你批准”；绿/红只表示状态和 diff 计数。

原生约束（必须遵守）：纯色填充、1 DIP 边框、圆角矩形、只有浮层带一层简单阴影；
不用 backdrop blur、渐变、发光、纹理。图标只用 Lucide（stroke 1.75，13–17 DIP），不用 emoji。

## 2. Token：唯一来源 `internal/kit/theme.go`

面板里**不允许**写颜色字面量（`ui.Hex("#...")`）、字号数字以外的魔法色；缺什么就加 token。
名字与设计的 CSS 变量一一对应，方便对照。

| Token（kit） | CSS 变量 | 深色 | 浅色 | 用途 |
|---|---|---|---|---|
| `BG` | `--bg` | `#131416` | `#FBFBFA` | 主区 |
| `Side` | `--side` | `#0F1012` | `#F3F3F1` | 侧栏、设置导航、分段控件底 |
| `Surface` | `--surface` | `#18191C` | `#FFFFFF` | 卡片、输入框、工具卡 |
| `Raised` | `--raised` | `#1D1E22` | `#FFFFFF` | 弹层、对话框 |
| `Hover` / `Selected` | `--hover` / `--sel` | `#222327` / `#26272C` | `#ECECE9` / `#E6E6E2` | 悬停 / 选中行 |
| `Border` / `Border2` | `--border` / `--border2` | `#26272B` / `#34353B` | `#E3E3DF` / `#D2D2CD` | 分隔 / 控件描边 |
| `Text` / `Text2` / `Text3` | `--text…` | `#ECECE7` / `#A3A39D` / `#6D6D68` | `#18181A` / `#5C5C58` / `#8D8D88` | 正文 / 次要 / 注释 |
| `Accent` / `AccentBg` / `OnAccent` | `--accent…` | `#7C93FF` / 13% / `#0D0E14` | `#3654D6` / 9% / `#FFFFFF` | 唯一强调色 |
| `OK` `Warn` `Err`（+`…Bg`、`WarnLine`、`ErrLine`） | `--ok` … | `#4CC38A` `#E8B04A` `#F2726B` | `#1E8A55` `#9A6200` `#C8392F` | 状态 |
| `AddBg` / `DelBg` | `--addbg` / `--delbg` | ok/err 10% | ok/err 9%/8% | diff 行 |
| `Code` | `--code` | `#16171A` | `#F6F6F4` | 终端、代码块 |
| `Scrim` | `--scrim` | `rgba(6,7,9,.62)` | `rgba(24,24,26,.32)` | 弹层遮罩（纯色半透明） |
| `Shadow` | `--shadow` | `0 10 28 rgba(0,0,0,.45)` | `0 10 28 rgba(20,20,24,.12)` | 只给浮层 |

- **强调色**只用于：主按钮、进行中（转圈、计划当前步）、焦点、开关打开、选中的复选/图标。不用来填大块。
- **琥珀**只表示“等待你批准”（权限卡、待批准标签、计划里等批准的那一步）。不用琥珀表示“改动”。
- **绿/红**只表示状态（运行/空闲、失败）和 diff（`+N` / `−N`、新增/删除的文件）；修改用琥珀色的文件图标。
- 文件图标**不按语言着色**：颜色只来自它发生了什么（`kit.Theme.StatusColor`）。
- 外观可在 设置 → 外观 选：浅色 / 深色 / 跟随系统（`kit.NewFor(c, mode)`），两套层级等价。
- 代码配色用同一套色：关键词钴蓝、字符串/类型绿、数字/属性琥珀、标签红、注释 `Text3`。

### 字体

- 界面：**Geist**，中文落到系统的 CJK 字体（Noto Sans SC / PingFang SC / Microsoft YaHei UI）。
- 代码、路径、命令、数字、快捷键：**Geist Mono**。
- Geist 与 Geist Mono 以 SIL OFL 1.1 嵌入（`internal/kit/fonts/`，附 `OFL.txt`），`kit.RegisterFonts()` 在 `main` 里注册。
  不嵌 CJK 字体：单个字重就有 8–16 MB。

### 字号

| Token | 值 | 用在哪 |
|---|---|---|
| `FontMeta` | 11 | 分组标签、键帽、侧注 |
| `FontSmall` | 12 | 芯片、说明、mono 路径 |
| `FontRow` | 12.5 | 列表行、按钮、工具卡 |
| `FontUI` | 13 | 正文（行高 1.55） |
| `FontTitle` | 13.5 / 600 | 会话标题 |
| `FontH1` | 20 / 600 / −0.3 | 设置页标题 |
| `FontDisplay` | 30 / 600 / −0.8 | 新会话的问题 |

### 间距、圆角与尺寸

- 组内 6–10，组间 18–26；面板内边距 `Pad` 16，控件间距 `Gap` 8。
- 圆角：`RadiusS` 6（控件、行；按钮 7）、`RadiusM` 10（卡片、工具卡 8）、`RadiusL` 12（输入框、弹层、对话框）、
  `RadiusTag` 4（键帽、行内代码）。
- 高度：导航/列表行 `RowH` 30、标题栏 `HeadH` 48、按钮 `CtlH` 30（小号 26）、标签 20、输入框下的状态行 `BarH` 34。
- 宽度：侧栏 `SideW` 252、检查器 `InspectorW` 300、侧面板 `PanelW` 520、设置导航 `SettingsNavW` 236、
  对话列/设置内容 `ColumnW` 720（有检查器时 640，有侧面板时 440；设置的 Agents 与快捷指令 900）。

## 3. 排版

- 句首大写（英文），中文不加粗填充；不用全大写和字距做 eyebrow。
- 层级用顺序解决：字号 → 颜色（Text/Text2/Text3）→ 间距。粗体一屏最多两处（标题、当前项）。
- 数字、状态、计数靠列对齐；代码、路径、命令用 Geist Mono。
- 快捷键写成 `Ctrl+N`、`Shift`、`Enter`（macOS 自动换成 ⌘/⇧）。

## 4. 布局与表面

- 三层表面：`Side`（侧栏）< `BG`（主区）< `Surface`（卡片/控件）；浮层是 `Raised` + `Border2` + 一层阴影。
- 分隔用 1 DIP 的 `st.HRule()` / `st.VRule()`；卡片有边框没阴影。
- 主区标题栏 48 DIP，可拖动窗口，右侧给窗口按钮留位（`c.TitleBar()`）。
- 对话列居中；右侧要么是 300 的检查器（计划 / 本会话 / 改动），要么是 520 的面板（变更 / 文件 / 终端）。
- 空状态用 `st.EmptyState`：一个图标 + 一句标题 + 一句说明。**不放假数据**：设计里有、后端还没有的东西
  （用量、MCP 列表、角色、记忆、分享）画成真实的空状态，并在 [docs/roadmap.md](docs/roadmap.md) 记为缺口。

## 5. 组件与图标

组件都在 `internal/kit`（见 [docs/kit.md](docs/kit.md)）：按钮（主/默认/幽灵，可带键帽）、图标按钮、标题栏按钮、
芯片、导航项、分组标签、标签（`Tag`，20 DIP）、状态点（`Dot`，空心环 = 未启动）、键帽、分段控件、开关、
下拉、卡片与设置行、进度条、头像、Agent 标识、浮层样式、列表行、diff 块、代码井。

- Agent 标识：omo **不附带第三方 logo**；Agent 画成首字母方块，Pi 用 Lucide `pi` 字形反色方块。
- 图标来自 [lucide.dev](https://lucide.dev/icons/)，`internal/kit/icons/*.svg` 是原文件（lucide-static 1.70.0），
  用 `./scripts/lucide-icons.sh` 更新；**不要手抄 SVG path**。
- 纯图标控件必须有 `Label`（它同时是 tooltip 与无障碍名）。
- 点击目标不嵌套：可点行里的开关/按钮必须是兄弟节点（定时任务表格的开关就是这样）。

## 6. 文案

- 所有可见文案走 `i18n.T` / `i18n.Tf`，`en.json` 与 `zh-Hans.json` 同时加；中文按设计稿。
- 动作用动词：「允许一次」「重新登录」「用 Codex 继续」；状态说清发生了什么、接下来怎么办。
- 错误带对象（Agent 名、路径、命令）并给出可执行的修复。

## 7. 动效与反馈

- 默认静止：没有 hover 位移、缩放、渐显、脉冲。“运行中”是一个静止的 loader 图标，不转。
- 反馈靠状态本身：行高亮、标签、按钮态。

## 8. 可访问性

- 所有可点元素 `Focusable()`，纯图标必须有 `Label`；Esc 关闭浮层。
- 明暗两套都自测对比度；`Text3` 不承载必读信息。
- 不只用颜色表达增删改：文件行同时有状态字母（A / M / D）与 `+N −N`。

## 9. 反模式（见到就改）

1. 渐变、发光、玻璃、模糊、纹理、装饰性阴影（阴影只给浮层）。
2. 第二个强调色；琥珀用在“等待批准”以外；绿/红用在状态与 diff 以外。
3. 卡片套卡片、每个数字一个框。
4. emoji 当图标、图标贴彩色底（Agent 标识与头像除外）。
5. 假数据、假按钮：没有后端就画空状态，按钮只放能用的。
6. 手写颜色、圆角、间距；绕过 `internal/kit`。
7. 动效装饰：hover 上浮、脉冲状态灯、转圈。

## 10. 落地流程（AI 或人）

1. 动手前读：本文 → [docs/kit.md](docs/kit.md) → [docs/ui.md](docs/ui.md)；对照 Doop 帧（`get_frame_screenshot`）。
2. 只组合 `internal/kit`；缺组件先加在 kit 里（写包内测试）。
3. 加 token 时 `palette` + `Theme` 字段 + `NewFor()` 三处一起改，明暗两套都给值。
4. 文案走 i18n 两个目录；键名 camelCase。
5. 验证：`go build ./... && go vet ./... && go test ./...`、`mygo vet .`、`gofmt -l`；
   然后重生成截图（[docs/ui.md](docs/ui.md)）并和对应的 Doop 帧并排比对。
