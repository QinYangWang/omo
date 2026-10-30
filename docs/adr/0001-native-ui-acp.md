# ADR-0001：原生 UI（MyGo）+ ACP v1 —— 架构基线

- 状态：**已接受（Accepted）**，2026-10-29 确认；P0 已按此实现
- 日期：2026-10-29
- 决策者：产品 owner + 架构
- 相关：`docs/dependencies.md`、`docs/architecture.md`、`docs/security.md`

## 背景

要构建一个「Go 写的、原生的、低内存」AI Coding IDE，具备文件树、代码编辑器、Diff 审查、
终端、LSP、Git，并通过 ACP 接入多个本地 Agent Runtime。硬约束：

1. 主 UI 必须是 Go + 原生绘制，**不得**用 WebView/Electron/React/TS 作为主 UI 运行时。
2. `CGO_ENABLED=0` 必须能构建（且要跨平台）。
3. 低内存、低空闲 CPU、快启动优先于功能广度。
4. Agent 之间以 **ACP** 为协议边界，不耦合任何具体 Agent 的内部 API。
5. 第一版用稳定 ACP v1，不追实验性 v2。

这些约束同时成立时，可选空间非常小：要么自己写一整套原生 UI + 编辑器 + 终端渲染，
要么找到一个已经提供这些能力的原生 Go 框架。

## 决策

### D1：主 UI 用 `github.com/egoist/mygo` v0.7.3 的原生 UI（`ui`），不用 WebView

**理由（大部分已实测，见 dependencies.md §8）**

- `mygo/ui` 是**自绘**的立即模式工具包：Metal / Direct3D 11 / OpenGL / CPU 渲染，
  文本走系统引擎（DirectWrite / Core Text / Pango）。`WindowOptions.Content` 直接显示
  用户界面，**不创建 WebView，也不启动 WebKit/WebView2 的子进程**。
- 我需要的控件都已存在且是我实测过签名的真实 API：`Sidebar/SidebarItem/SidebarSection`、
  `Split/SplitVertical`、`Tabs`、`Tree/TreeItem`、`Table(*ListState)`、`Scroll`、`Toolbar`、
  `Modal`、`AlertDialog`、`MenuButton`、`Combobox`。
- 空闲行为符合目标：框架文档记录 settled 窗口不再请求帧、不装定时器、空闲 CPU ≈0%；
  这是**框架作者的测量**，我们仍要自测（roadmap P0 验收项）。
- `mygo.WatchFiles`、`plugins/terminal`、`plugins/sqlite`、`ui/editor` 同属一个模块，
  版本一致、无跨框架适配层。
- 无 cgo：整个依赖图 `CgoFiles` 为空，6 个平台 `CGO_ENABLED=0` 交叉编译通过（实测）。

**考虑过的替代**

| 方案 | 为什么不选 |
|---|---|
| Wails / 自带 WebView2 / WebKitGTK | 直接违反「不得以 WebView 为主 UI 运行时」；WebView 还意味着额外渲染进程与几十 MB 常驻内存 |
| Fyne、Gio 等纯 Go 原生 UI | 它们提供**控件工具包**，不提供代码编辑器（rope buffer、语法高亮、折叠、多光标、diff 视图、补全/悬浮 UI）也不提供终端模拟器。选它们等于自研编辑器 + 终端 + 文本整形，是数人月的工作量，且低内存目标更难保证 |
| Qt/GTK 绑定 | 需要 cgo，违反 C7 |
| 自己用 purego 写 Win32/Cocoa/GTK 三套后端 | 与 MyGo 已做的事重复，且文本整形（复杂脚本、双向文字、输入法）是自己造轮子的深坑 |
| 终端 TUI（bubbletea 等） | 不是「类似 VS Code/Zed 的核心 IDE 体验」，且无法承载 Diff 审查与多面板布局 |

**代价 / 风险**

- 引入一个年轻框架（v0.7.x，`ui` 有过 breaking change，仓库里有 `mygo migrate-ui` 工具与迁移文档）。
  缓解：锁版本、UI 层保持薄、`mygo vet` 进 CI、升级前读 `docs/ui/migration.md`。
- 交付形态绑定 MyGo 的打包工具（`mygo build`），尤其 SQLite 原生库必须随包分发。
  缓解：CI 里就跑 `mygo build`，不只跑 `go build`。
- 如果未来 MyGo 停止维护，UI 层要重写（架构性风险，接受；见 dependencies.md §6）。

### D2：Agent 协议用 ACP v1（`acp-go-sdk` v1.5.1）

- `acp.WireProtocolVersion = 1`，SDK 的类型生成自官方 schema-v1.26.0，
  并在 README 声明与官方 TypeScript/Rust SDK 做过四向互通测试。
- 它是 ACP 社区库列表中的 Go 实现，只依赖 `golang.org/x/sys`，许可证 Apache-2.0，
  `go 1.23`（低于我们的 1.27.3，不抬高门槛）。
- 我们**不需要**自己实现 JSON-RPC：SDK 提供双向调用、通知顺序保证、有界队列
  （`MaxFrameSize`/`MaxQueuedNotifications`/`MaxNotificationBytes`…）、取消请求、
  `AfterResponse` 钩子、以及 stdio 子进程管理。
- 不追 v2：v1 是稳定版；v2 的收益（未定）不抵 MVP 的稳定性成本。
  `acpclient` 里硬门禁 `protocolVersion == 1`，升级是一个显式动作。

**代价 / 风险**

- 类型化 `Client.SessionUpdate` 联合在遇到**未知变体**时直接丢弃（**我们已实测复现**：
  回调不被调用，SDK 记 WARN `no matching variant for union`，连接存活）。
  这不满足「不得丢弃未知 ACP 内容」。P2 实装已改用 `acp.NewConnectionWithOptions` +
  项目内 raw `MethodHandler`（出站仍用 `acp.SendRequest[T]`）：已知变体在内部归一化，
  未知变体进入有界、脱敏的诊断流，不再经过会丢弃它们的类型化联合解码。

### D3：每个 Agent Runtime 跑在独立子进程，走 stdio

- **崩溃隔离**：Agent 是第三方本地程序，可能 OOM、panic、无限输出。独立进程意味着 IDE 不受影响，
  且可以强杀整棵进程树。
- **内存可分账**：IDE 核心内存与 Agent 内存分离，空闲回收只影响子进程（见 architecture.md §8）。
- **语言无关**：Runtime 可以是任何语言写的 CLI；IDE 不需要 Node，也不链接它们的库。
- **权限边界更清晰**：子进程是普通用户进程（**不是沙箱**，见 security.md §1），
  但至少其生命周期、stdin/stdout、stderr 完全由 IDE 掌握。
- SDK 已经实现难点：Windows kill-on-close Job Object、Unix 进程组、
  先优雅后强杀的 `Shutdown(ctx)`、Windows 不弹控制台，以及「stdout 只走协议、stderr 走日志」的约定。
- 启动永远是 `executable + args`，SDK 明确「never invokes a shell」。

**代价**：进程启动 100 ms 级延迟；需要处理「进程重启 ⇒ 连接失效」的两段式生命周期
（connection 与 session 分开建模，architecture.md §5.3）。

### D4：IDE 不绑定 Pi Durable（或任何具体 Agent）

- 产品要求「通过 ACP 接入多个本地 Agent Runtime」。把 Pi Durable 的内部 API 写进 Core，
  等于把一个可替换组件变成架构前提。
- Pi Durable Harness 在这个架构里**只是一条 `AgentDef`**：`{Executable, Args, Env, DirMode, Trusted}`。
  将来接入它、切换它、并行跑它，都不需要改 IDE Core。
- 我们只使用 ACP 的**标准能力**：`initialize`、`session/new`、`session/load`（能力为真时）、
  `session/prompt`、`session/cancel`、`session/update`、`session/request_permission`。
  非标准字段只写进 `_meta` 并当作不透明数据。
- 「Pi Durable Harness / Skills / MCP」等扩展点保留在 `AgentRegistry` 与
  `NewSessionRequest.McpServers`（协议已有字段）上，不提前实现。

**代价**：无法使用某个 Agent 的私有增强能力（除非它通过 ACP 扩展暴露）。
这是有意的：可替换性 > 单 Agent 深度集成。

### D5：优先用 MyGo 自带的 Editor / Terminal / SQLite / Watch

| 能力 | 用 MyGo 的理由 | 我们仍需自研的部分 |
|---|---|---|
| 编辑器 | `editor.Buffer` 是 rope 快照 + 版本号 + undo/redo；`editor.State` 有折叠、多光标、查找、inlay、diagnostics、补全菜单、hover 卡片、gutter marks、`DiffBase`；渲染按可视区域 | 打开/保存管线、LSP ↔ 编辑器映射（MyGo 只给三个回调钩子：`OnCompletion`/`OnHover`/`OnDefinition`） |
| Diff | `editor.DiffState` + `editor.DiffView` 已有 hunk、`Accept(i)`/`Revert(i)`、`Stats()`、行内词级差异 | baseline 管理（相对谁 diff）、接受/拒绝后写回磁盘、超限降级 |
| 终端 | `plugins/terminal` 是 Ghostty 的 Go 移植：PTY、主题、键盘、选择、链接、`Snapshot()`、`ExitCode()`、`Conn io.ReadWriteCloser` | Tab 管理、执行策略、与 ACP `terminal/*` 隔离 |
| SQLite | purego 加载 Zig 编译的 amalgamation（**无 cgo**），SHA-256 校验，6 平台齐全；`DB.Execute/Query/Transaction` 带 ctx 与取消 | schema、迁移、保留策略、脱敏 |
| 文件监听 | `mygo.WatchFiles` 三平台后端、debounce、`Ignore`、`MaxEntries`、事件合并 | 事件 → 重读 → 冲突协调（Buffer 语义） |

自研这些中的任何一个都会显著增加代码量、内存占用与平台风险，并且不会带来差异化价值。

**代价**：编辑器/终端的行为受 MyGo 约束（例如终端没有 Linux primary selection —— 框架文档明示）。
可接受。

## 决策记录（2026-10-29）

- 模块路径 `github.com/QinYangWang/omo`。
- P2 的首个真机验证对象：**codex** 与 **pi**（两个，以覆盖能力差异）。
- P5 LSP 采**选项 B**：自写子集客户端，不引入 `go.lsp.dev/*` 及其伪版本依赖。
- P2 已采用 raw handler：未知 `sessionUpdate` 变体保留有界诊断，不做 UI 语义猜测。
- P0 已实现：原生布局（Sidebar + 双 Split + Tabs + 真实 editor）、命令表、
  i18n（en / zh-Hans）、启动与空闲基准。

## 后果

**正面**

- 单个 ~20 MB 二进制（未 strip）、无 Node/无 WebView、无 cgo，6 平台交叉编译通过（实测）。
- ACP 层可以**完全不用子进程**做单元测试（`net.Pipe` + SDK 双端构造，已实测通过）。
- UI 层可以 headless 测试（`ui.NewTester`，已实测渲染 Sidebar+Split+editor）。
- 替换 ACP SDK、替换 SQLite、替换 LSP 实现都不需要动 UI。

**负面 / 已知缺口**

1. MyGo 年轻，API 会变；锁版本 + 薄 UI 层。
2. 打包依赖 `mygo build`（SQLite 原生库）。
3. 未知 ACP 更新变体不再进入 SDK 类型化联合解码；P2 raw handler 只保证诊断保留，
   新变体的 UI 语义仍需逐个实现。
4. 编辑器没有内建 LSP Client（只有钩子），LSP 必须自研（P5）。
5. 终端不允许 Agent 直接驱动 UI 状态：Agent 的命令执行必须经 `Terminal/Execution Service`
   （架构要求，不是框架限制）。

## 未采用但记录在案的选项

- **在 IDE 内跑自研 Agent Loop**：违反「ACP 是边界」，且把模型接入、工具执行、上下文管理
  都变成我们的责任。不是本项目目标。
- **多 Workspace / 多窗口**：MVP 单窗口单 Workspace；多窗口留给 P6（`Window.Update` 模型天然支持，
  但服务层需要按 Workspace 分组，推迟）。
- **云端 Agent**：ACP 目前是 stdio；远端需要 transport 抽象，P6 再评估。
