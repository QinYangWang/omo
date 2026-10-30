# 实施路线图（roadmap）

> 状态：**P0/P1 已完成，P2 核心与 codex/pi 实机互操作已验收**；Pi 的工具权限转发限制见 §9.2.1。
> 阶段顺序按依赖关系排，不按重要性排。
> 每个阶段结束时必须能 `go build`（6 平台）、`go vet ./...`、`go test ./...`、`go test -race ./...` 全绿。

## 0. 阶段总览

| 阶段 | 目标 | 对应 MVP 条目 | 依赖 | 预计改动面 |
|---|---|---|---|---|
| **P0** | 骨架 + 工具链 + 测量基线 | 1, 15 | 无 | `main.go`、`internal/{app,ui,commands}`、CI |
| **P1** | Workspace / 文件树 / 编辑器 / 保存 / 冲突 | 2, 3, 4 | P0 | `internal/{workspace,documents,ui}` |
| **P2** | ACP 主干：进程 + 连接 + Session + 流式 + 取消 + 权限 | 6, 7, 8, 9, 10, 11, 12 | P1（cwd 需要 Workspace） | `internal/agent/*` |
| **P3** | Diff 审查 + SQLite 元数据与会话恢复 | 13, 14 | P2 | `internal/{diff,persistence}` |
| **P4** | 原生终端 + Git 状态 | 5 | P1 | `internal/{terminal,git}` |
| **P5** | LSP（先决策再实现子集） | — | P1, P3 | `internal/lsp` |
| **P6** | 扩展：多 Agent / MCP / Skills / 多 Workspace | — | P2–P5 | 按需 |

P4 可以并行在 P2 之后插队（不阻塞 ACP），但不要与 P1 并行——文件模型未定型时做终端会返工。

## 1. P0：骨架与工具链

**范围**：能开窗、能显示一个假的三栏布局、命令注册器可用、CI 与测量脚本就位。不读写任何文件。

交付：
- `go.mod`（`go 1.27.3`）、`mygo.json`、`main.go`、`resources/icon.png`。
- `internal/app`（`AppState`、`Dispatch(Intent)`、窗口生命周期 + `App.OnQuit` 清理钩子）。
- `internal/commands`（Registry + 3 个示例命令：Quit、TogglePanel、OpenWorkspace 占位）。
- `internal/view`（shell：Sidebar(Explorer 假树 + Search + Git) / Tabs / Editor / AgentPanel /
  BottomPanel / StatusBar；用 `Split`/`SplitVertical`/`Sidebar`/`Tabs` 真实组件）。
- `docs/benchmarks.md` + `scripts/bench/`（冷启动、RSS、空闲 CPU 的采集脚本）。
- CI：`go build`（6 平台交叉）、`go vet ./...`、`mygo vet`、`go test -race ./...`、
  cgo 断言（`go list -deps -f '{{if .CgoFiles}}{{.ImportPath}}{{end}}'` 必须为空）。

验收（可执行）：
1. `CGO_ENABLED=0 go build` 在 windows/amd64、linux/amd64、darwin/arm64 通过（其余平台 CI 交叉编译）。
2. 窗口 300 ms 内出现首个可交互帧（本机 3 次中位，记录进 `benchmarks.md`）。
3. 空闲 60 s CPU 时间增量 < 50 ms（本机基线，记录实测值，不设产品承诺）。
4. `ui.NewTester` 测三栏布局：断言 ActivityBar/Explorer/StatusBar 文本存在，点击 TogglePanel 后布局变化。
5. 关闭窗口 → `App.OnQuit` 打印清理日志；进程退出码 0。

**风险**：暂无技术风险；唯一注意 `go 1.27.3` 工具链必须可获取（见 dependencies.md §2）。

## 2. P1：Workspace / 文档 / 编辑器

**范围**：真打开目录、真浏览、真编辑、真保存、外部变化冲突。

交付：
- `internal/workspace`：`Open/Close/ReadFile/WriteFile/Stat/List/Canonical/Watch`，
  内部 `os.OpenRoot`，大小上限，非普通文件拒绝，`Ignore` 规则，watcher 合并。
- `internal/documents`：Buffer 权威源、`Save`（原子写）、`ReloadFromDisk`、冲突状态。
- `internal/view`：真实文件树（`Tree`/`TreeItem` 或 `Table`+`ListState` 虚拟化，目录懒加载）、
  多 Tab（`Tabs` + 每 Tab 一个 `editor.State`）、脏标记、`Cmd/Ctrl+S`。
- 状态栏显示 Workspace 名与相对路径。

验收：
1. 打开 10k 文件的目录 < 300 ms；展开子目录才 `readdir`（用计数器断言只读了一层）。
2. 打开 1 MiB Go 文件可编辑、输入延迟无可感卡顿；20 MiB 文件被拒绝并给出提示。
3. 保存后 `stat` mtime/hash 变化；崩溃前未保存内容有恢复副本（MyGo `NewDocuments` 或自管
   `*.recover` 临时文件，二选一，P1 定）。
4. 外部 `echo >> file` 且 Buffer 干净 → 自动重载并保留光标行；
   外部改动且 Buffer 脏 → 弹出冲突对话框，三选一都可验证。
5. 路径安全测试全绿：`../escape`、绝对路径、指向根外的符号链接、`/proc/self/mem`（Linux）、
   FIFO、设备文件、目录当文件打开。
6. `go test -race ./...` 通过（watcher + Buffer 并发路径）。

**技术验证点**（P1 必须实测并记录）：
- `mygo.WatchFiles` 在三个平台的事件合并行为与 `MaxEntries` 上限触发时的错误表现。
- `editor.Buffer` 在大文件下的 `Snapshot()` 分配量（决定 LSP 快照策略）。

## 3. P2：ACP 主干（本项目最高风险阶段）

**范围**：一条端到端可用路径——配置一个 Agent、启动、初始化、建 Session、发 Prompt、
流式显示、取消、权限审批、崩溃与重启。

交付：
- `internal/agent/catalog`：Agent 定义 CRUD + 校验 + 首次信任弹窗（P2 先存 JSON 文件，
  P3 迁到 SQLite）。
- `internal/agent/process`：`stdio.StartClient` 封装、stderr 环形缓冲、退出码、
  `StopAll`、进程状态机。
- `internal/agent/acpclient`：**唯一** import ACP SDK 的包。
  `Initialize` 校验 `protocolVersion == 1`；能力快照；`ErrUnsupported` 语义；
  `Handler.Update`/`Handler.AskPermission`。
- `internal/agent/events`：归一化 + 幂等合并 + text delta 批量（16–33 ms）+ 诊断环形缓冲。
- `internal/agent/permissions`：`Ask/Resolve/CancelAll`，默认拒绝，无超时放行。
- `internal/agent/sessions`：状态机（interfaces.md §5）+ 串行 Prompt + `Reconnect`/`Restore`。
- `internal/view`：AgentPanel（transcript、工具活动、计划）、权限 Modal、取消按钮、连接状态。

验收：
1. 配置一个真实 ACP Agent（如任一支持 ACP v1 的本地 CLI），点启动 → 状态从 `Absent` → `Running` → `Ready`。
2. 发 Prompt → 文本增量按批渲染（单帧 token 数可观测，不允许每 token 一帧）。
3. 权限请求弹出原生 Modal；拒绝后 Agent 收到 `reject`；允许后继续；
   **超时只可能拒绝，绝不自动允许**（单测断言）。
4. 点取消 → `session/cancel` 发出，turn 在 2 s 内结束，迟到事件只进诊断。
5. `kill -9` Agent 进程 → IDE 不崩、面板显示「已断开」、活跃 turn 标记为 `Unknown`；
   点重启 → 新进程 + 新连接；若 Agent 不支持 `loadSession`，明确提示无法恢复。
6. 假 Agent（`net.Pipe`）测试集全绿：初始化、流式、取消穿透、断线、`loadSession=false`、
   未知 `sessionUpdate` 变体。
7. `go test -race ./...` 通过；空闲（Agent 已启动但无 turn）CPU 无可测增长。

**技术验证点**：
- 至少验证 **2 个不同 Agent Runtime**（若有 `loadSession` 能力差异，必须都覆盖）。
- 实测 SDK `ConnectionOptions` 的默认上限是否适合大工具输出（必要时调小）。
- 未知变体行为（architecture.md §9）在真 Agent 上是否真会触发。

## 4. P3：Diff 审查 + 持久化

**范围**：Agent 改文件后能看 diff、逐 hunk 接受/拒绝；IDE 元数据落 SQLite 并能重启恢复。

交付：
- `internal/diff`：baseline 采集（仅被 `tool_call` 触及的路径）、hunk 计算、接受/拒绝写回、
  超限降级；对接 `editor.DiffState`/`editor.DiffView`（`DiffState.Accept(i)`/`Revert(i)`/`Stats()`）。
- `internal/persistence`：`schema_migrations`、上表、批量事件写、`PruneEvents`、迁移测试。
- `internal/view`：Diff Tab（side-by-side 或 unified，用 MyGo 的 `DiffLayout`）、
  「接受全部/拒绝全部/逐 hunk」、变更文件列表。

验收：
1. Agent 修改 3 个文件 → Diff Tab 列出 3 个文件与 added/deleted 行数；
   逐 hunk 接受/拒绝后磁盘内容与预期一致（测试断言文件内容）。
2. 未在 IDE 打开的、被 Agent 修改的文件同样进入审查（靠 watcher 发现）。
3. Diff baseline 超过 64 MiB → 降级并提示，不 OOM。
4. 重启 IDE → 恢复最近 Workspace、Tab 布局、Agent 定义、Session 映射；
   Agent 支持 `loadSession` 时恢复会话，不支持时明确提示。
5. SQLite 迁移测试：v1 建库 → 插数据 → 模拟 v2 迁移 → 数据不丢；
   参数化 SQL（不接受拼接）；`PruneEvents` 后行数符合上限。
6. 退出应用后进程表中无孤儿 Agent（Windows Job Object / Unix 进程组验证）。

## 5. P4：终端 + Git

**范围**：原生终端面板（`plugins/terminal`）、Git 状态/分支/基本 stage。

交付：
- `internal/terminal`：`terminal.New(Options{Command, Dir: workspaceRoot, Env})`、Tab 管理、
  上限（默认 4）、关闭时 `Terminal.Close()` 并等待 `Done()`。
- `internal/git`：`status --porcelain=v2`、`branch --show-current`、`diff`、`add`、`log -n`。
  全部 `exec.CommandContext` + argv，超时与退出码处理。
- UI：底部 Terminal/Problems/Output 面板切换；状态栏 Git 分支；Explorer 的 Git 分组。

验收：
1. 打开终端 → cwd 是 Workspace 根；`pwd`/`cd` 正常；4 个 Tab 上限生效并有提示。
2. 关闭 Tab / 关闭窗口 → PTY 关闭、无残留进程。
3. Git：修改文件后状态栏与 Explorer 立即反映（watcher 驱动，不轮询）；
   stage 后状态变化；非 Git 仓库显示明确提示而不是错误弹窗。
4. Git 命令注入测试：文件名含空格/引号/`;`/`$(...)` 时行为正确（argv 不经过 shell）。

## 6. P5：LSP（先决策）

**前置决策**（必须先有结论才能写代码）：
- 选项 A：引入 `go.lsp.dev/protocol` v1.0.1 + 伪版本 `go-json-experiment/json`（`replace` 钉死）。
- 选项 B：只实现子集，用 stdlib `encoding/json` 自写 ~400 行客户端（零新依赖）。

推荐 B：我们只需要 `initialize`、`didOpen/didChange/didClose`、`publishDiagnostics`、
`completion`、`hover`、`definition` 六个方法，与 `editor.State` 的三个回调刚好对齐；
而 A 引入一个实验性伪版本依赖，违反依赖准入规则。

交付（选 B 时）：
- `internal/lsp`：行分帧（`Content-Length`）、请求 ID 管理、`initialize` 握手与能力读取、
  文档同步（`didChange` 用增量或全量，先全量，实测后再优化）、诊断推送。
- 接线：`editor.State.OnCompletion` → LSP → `State.ShowCompletions`；
  `OnHover` → `State.ShowHover`；`OnDefinition` → `State.GoTo`；诊断 → `State.SetDiagnostics(version, …)`
  （版本不匹配就丢弃，避免错位）。
- 懒启动：只对该 Workspace 出现过的语言启动；未安装服务 → 状态栏明确提示「未找到 gopls」。

验收：
1. Go Workspace：gopls 启动后，诊断出现在编辑器与 Problems 面板；补全可用；F12 跳转可用。
2. 未安装 gopls → 明确提示，不崩溃、不刷错误日志。
3. 关闭 Workspace → LSP 进程被清理。
4. 大文件（> 1 MiB）默认不同步（可配），避免 LSP 与内存双重压力。

## 7. P6：扩展（不在 MVP）

多 Agent 并行、MCP servers（`NewSessionRequest.McpServers` + `McpCapabilities` 协商）、
Skills 目录、Pi Durable Harness 接入（只是 `AgentDef` 的一条定义）、多 Workspace、
云端 Agent。这些都**不改核心接口**，只在既有扩展点上加实现。

## 8. 主要风险与验证点

| # | 风险 | 影响 | 缓解 / 验证 | 阶段 |
|---|---|---|---|---|
| R1 | MyGo v0.7.3 是较新的框架，API 可能在小版本变动（`ui` 有 `mygo migrate-ui` 迁移工具，说明确实会变） | 返工 | 锁定 v0.7.3；UI 层薄；`mygo vet` 进 CI；升级前读 migration.md | 持续 |
| R2 | 未知 `sessionUpdate` 变体被 SDK 丢弃（**已实测复现**） | 兼容性 | P2 已改用 raw `MethodHandler`；未知变体进入有界脱敏诊断 | P2 |
| R3 | ACP 能力声明与实际不符（声明了未实现的能力） | 协议不可信 | 默认全 false；SDK 自动 `method-not-found`；`TestCapabilitiesHonest` | P2 |
| R4 | 权限请求阻塞 SDK handler 导致流停顿 | 卡死 | `Ask` 只在 handler goroutine 阻塞，UI 主线程不阻塞；有单测 | P2 |
| R5 | 终端/Ghostty 插件在目标平台的行为差异 | 平台缺陷 | P4 三平台手测；PTY 清理断言 | P4 |
| R6 | SQLite 原生库打包遗漏 | 发布版启动失败 | `mygo build` 打包检查 + 启动自检（`sqlite.Load()` 失败 → 明确错误） | P3 |
| R7 | 内存超标（transcript / diff baseline / 大文件） | 违背产品目标 | 有界缓冲 + 基准测试进 CI（软门槛） | P1 起 |
| R8 | 编辑中的 Buffer 与 Agent 写入冲突 | 数据丢失 | 冲突对话框 + 原子写 + 恢复副本；冲突测试 | P1/P3 |
| R9 | 三方 Agent 的 `session/load` 语义差异（是否回放历史） | 体验不一致 | 只在能力为真时调用；结果作为 hint，不当事实 | P3 |
| R10 | go1.27.3 工具链在 CI 缺失 | 构建失败 | CI 显式 `go-version: 1.27.3`；禁用 `GOTOOLCHAIN=auto` 以外的不确定性 | P0 |

## 9. P0 完成记录（2026-10-29）

代码已落地，模块路径 `github.com/QinYangWang/omo`。

| # | 任务 | 状态 | 落点 |
|---|---|---|---|
| 1 | `go mod init` + `go 1.27.3` + 钉 mygo v0.7.3 | ✅ | `go.mod`（ACP SDK 留到 P2，避免未使用依赖） |
| 2 | 建项目骨架 | ✅ | 手工按 `cmd/mygo/template/native` 抄写（目录已非空，`mygo init` 不适用） |
| 3 | `mygo.json` + 图标 | ✅ | `mygo.json`（含 `i18n.dir`）、`resources/icon.png`（256×256 PNG） |
| 4 | `main.go` 只做装配 | ✅ | `main.go` |
| 5 | `internal/app`：状态 + Dispatch + Shutdown | ✅ | `internal/app/{app,intent,builtins,helpers,bench}.go`，`Notice` 只存 i18n key |
| 6 | `internal/view`：三栏 + 底部 + 状态栏 | ✅ | `internal/view/shell.go`（Sidebar + 2 个 Split + Tabs + 真实 `editor.View`） |
| 7 | 命令表 + 内置命令 | ✅ | `internal/commands/registry.go`，`app.quit` / `view.togglePanel` / `workspace.open` |
| 8 | 视图测试（headless） | ✅ | `internal/view/shell_test.go`（布局文本、点击文件开 Tab、关闭回欢迎页、隐藏面板） |
| 9 | 状态转移单测 | ✅ | `internal/app/app_test.go`（Tab 幂等/裁剪、面板、命令失败、Shutdown 幂等） |
| 10 | CI | ✅ | `.github/workflows/ci.yml`（3 OS 测试 + 6 目标交叉编译 + cgo 断言 + `mygo vet`） |
| 11 | 采集脚本 + 真实基线 | ✅ | `scripts/bench/{bench.ps1,bench.sh}` → `docs/benchmarks.md` |
| 12 | 三平台交互手测 | ⏳ | 仅在本机（Windows）跑过窗口创建/首帧/退出；resize、深浅色、输入法待手测 |

额外落地（P0 期间确认的要求）：

- **i18n**：`internal/i18n`（`//go:embed locales/*.json` + `mygo/i18n` 的 `Catalog.Format`），
  en 为源语言、zh-Hans 译本，视图全部走 `i18n.T/Tf`；缺 key 时返回 key 本身，缺口可见。
- **英文注释**：代码注释与标识符全英文；产品文案只在 catalog 里出现中文。

P0 验收数字（本机，见 `docs/benchmarks.md`）：

- 首帧中位 **84.4 ms**（n=9，79.1–90.9 ms），空闲 45 s CPU 增量 **0.000 s**，
  working set 稳定在 **72.0 MB**；`go build` 之后第一次运行会被 Defender 扫描污染，
  基线取第二次运行（原因与两次数据都记在 `docs/benchmarks.md`）。
- 6 目标 `CGO_ENABLED=0` 交叉编译通过，产物 15.2–16.9 MB；依赖图 **无 cgo 包**。
- `go build` / `go vet` / `go test` / `go test -race` / `mygo vet` 全绿。

## 9.1 P1 完成记录（2026-10-29）

用户确认的顺序调整：先把**文件树、Diff、终端**做好，ACP 不着急（终端里也能起 Agent）。

| 交付 | 落点 | 测试 |
|---|---|---|
| 工作区边界（`os.Root`、大小上限、非普通文件拒绝、懒加载目录） | `internal/workspace` | `service_test.go`（含路径穿越、符号链接、FIFO、超大文件） |
| 文档权威源 + 原子保存 + 磁盘冲突 | `internal/documents` | `store_test.go`（含 CRLF 保持、同尺寸同 mtime 冲突） |
| git 封装（分支、改动列表、HEAD 文本，含子目录前缀） | `internal/git` | `repo_test.go` |
| Diff 审查（HEAD 基准 / 未保存缓冲基准 + 应用） | `internal/diff` | `review_test.go` |
| 真实文件树（懒加载、脏标记）、编辑器、冲突对话框、Diff 标签页、终端面板、Chat 占位、状态栏（分支/改动数/Ln·Col/空格/编码/换行/语言） | `internal/app`、`internal/view` | `app_test.go`、`shell_test.go`（含端到端「审查并回退」） |

P1 验收：`go build` / `go vet` / `go test` / `go test -race` / `mygo vet` 全绿；
6 目标 `CGO_ENABLED=0` 交叉编译通过；i18n 68 条文案 en/zh-Hans 对齐。

P1 实测（`docs/benchmarks.md`）：首帧中位 38.9 ms；稳定态 116.3 MB WS / 108.3 MB private；
空闲每分钟 CPU 增量 0.000 s（一次性 +46 MB 与 0.031 s 发生在启动后 12 s 内，之后完全平）。

### UI 一轮改造（2026-10-29）

见 `docs/ui.md`。要点：新增 `internal/view/style.go` 设计令牌（颜色全部取自窗口主题，
因此跟随系统明暗）、外壳控件自绘（活动栏/标签页/状态栏/终端页签改为 `row`/`chip`）、
修掉三个真 bug（非输入事件不重绘、`Fill()` 让 1 DIP 分隔线盖住并挡住内容、
嵌套 `OnClick` 收不到点击）、底部面板关闭后不再占位、Chat 面板可拖拽可隐藏。

### 与 UI 参考图的对照

已对齐：左侧图标栏（46 DIP，图标项带无障碍标签）、248 DIP 侧栏 + 分区标题与折叠分区、
每标签一个关闭按钮 + 脏标记圆点、编辑器行号与编辑器视图、右侧对话面板、
底部 Terminal/Problems/Output 三页、状态栏（分支 / 改动数 / Ln·Col / 空格 / UTF-8 / 换行 / 语言）、
原生菜单栏（File / Edit / View，带平台加速键）。

尚未对齐（按价值排序）：编辑器上方的面包屑行、文件类型图标、右侧面板的会话列表与附件按钮、
诊断计数（需要 LSP）、标题栏居中的项目框。

### P1 未做（顺延）

- 工作区搜索（`searchPlaceholder` 仍只是提示）。
- 大目录/大文件的定量基准（需要生成脚本）。
- 每个标签页独立的光标恢复（目前只在重载时保持当前 caret）。
- 终端 tab 的 shell 标题跟随（`OnTitle` 已可用，未接）。

## 9.2 P2 核心实装记录（2026-10-29）

| 交付 | 落点 | 验证 |
|---|---|---|
| Agent JSON Catalog、argv/env 校验、原子保存、首次信任弹窗；信任绑定可执行文件 SHA-256 与完整 argv/env，变化后重新确认 | `internal/agent/catalog.go`、`internal/app/agent.go`、`internal/view/chat.go` | Catalog、二进制替换、启动参数变化与 App/View 测试 |
| 子进程 + ACP v1 initialize/new/load/prompt/cancel；协议版本门禁；fs/terminal 能力均 false | `internal/agent/manager.go` | argv 门控的真实测试子进程，覆盖 loadSession true/false |
| raw `MethodHandler`、文本/思考/工具/计划归一化、未知变体与 stderr 有界诊断 | `internal/agent/protocol.go` | 流式合批、未知变体、迟到更新测试 |
| 串行 turn、取消（忽略取消约 2 秒后断连）、权限默认拒绝/超时拒绝与结束事件、崩溃 turn=Unknown、用户触发重启 | `internal/agent/manager.go` | 权限、取消竞态、超时、崩溃、重启与连续运行测试 |
| 中央原生 Session/Chat、kit Modal、权限详情、取消/重启、Agent 管理与 Output 诊断；单 outstanding UI drain | `internal/app/agent.go`、`internal/view/{chat,terminal}.go` | App 状态、重复发送、权限结束、会话替换与 headless View 测试 |

已验证：`go test ./...`、`go vet ./...`、`mygo vet .`、`CGO_ENABLED=0 go build ./...`、
依赖图无 cgo。unknown 变体测试通过真实 ACP 子进程，不再只依赖 `net.Pipe`。

### 9.2.1 真实 Runtime 与 race 验收（2026-10-30）

安装并固定：WinLibs GCC 16.2.0、Codex CLI 0.166.0、`@agentclientprotocol/codex-acp` 2.5.0、
Pi 1.4.0、`pi-acp` 0.0.34。真实测试保留在 `internal/agent/runtime_integration_test.go`，
默认跳过，设 `OMO_ACP_INTEGRATION=1` 与两个适配器脚本路径后运行。

| Runtime | 实测结果 |
|---|---|
| Codex | initialize/new/Prompt 流式返回 `OMO_CODEX_OK`；`loadSession=true` 且重启恢复同 ID；read-only 模式下权限拒绝后文件未创建；一次取消超时在 2.03 s 断连并标 `Unknown` |
| Pi | initialize/new/Prompt 流式返回 `OMO_PI_OK`；`loadSession=true` 且重启恢复同 ID；取消在约 36 ms 完成 |

补充结论：显式 per-Agent env 现在可以覆盖继承白名单（用于 `INITIAL_AGENT_MODE=read-only` 等），
继承的凭据仍默认不透传。取消后的下一次 Prompt 会先重启连接并恢复 Session，避免 Pi 适配器
取消后仍持续旧流时污染新 turn。

**上游限制**：`pi-acp` 0.0.34 不转发 bash/write 的工具权限请求（只转发扩展 UI 权限），
因此 Pi 真机权限项无法由客户端强制验收；权限协议路径由 Fake Agent 覆盖。ACP 连接本身也不是
沙箱（见 security.md §1）。`allow_always` 在 P3 持久化按 Agent/Workspace/风险收窄的授权前暂不显示。

本机安装 WinLibs 后，`CGO_ENABLED=1 go test -race ./...` **全仓通过**。普通 `go test ./...`、
`go vet ./...`、六平台无 cgo 构建也通过。

## 9.3 下一步候选（P3 / P4）

- **P3 Diff 审查 + 持久化**：把 Agent 改动与 SQLite 元数据/会话恢复接到既有 ACP 主干。
- **P4 Git 深化**：stage/unstage、提交、分支切换；当前只有状态列表与 HEAD 对比。
- **P5 LSP**（选项 B）：自写子集客户端，接 `editor.State.OnCompletion/OnHover/OnDefinition`。


- [ ] `internal/workspace`：`os.OpenRoot` + `ReadFile/WriteFile(原子)/Stat/List/Canonical` + 大小与非普通文件限制。
- [ ] `internal/workspace`：`mygo.WatchFiles`（`Ignore` 跳 `.git`/`node_modules`，`MaxEntries` 上限）→ 事件只当提示。
- [ ] `internal/documents`：Buffer 权威源、`Save`、`ReloadFromDisk`、冲突状态（三选一对话框）。
- [ ] `internal/view`：真实懒加载文件树（`ListState` 虚拟化）、每 Tab 真实 `editor.Buffer`、脏标记、`Cmd/Ctrl+S`。
- [ ] 路径安全测试集：`../`、绝对路径、根外符号链接、FIFO、设备文件、超大文件。
- [ ] 冲突测试：干净 Buffer 自动重载；脏 Buffer 弹冲突；两者都要有断言。
- [ ] 更新 `docs/benchmarks.md`：加入「打开 1k/10k 文件」与「1 MiB 文件编辑」两组数字。

## 10. 决策记录（已确认）

| 事项 | 结论 | 影响 |
|---|---|---|
| 模块路径 | `github.com/QinYangWang/omo` | 已写入 `go.mod` 与文档 |
| 起步阶段 | P0 已完成，进入 P1；P2 的 ACP 层可与 P1 **并行**（`internal/agent/*` 不依赖视图与文件层） | P2 可独立开工 |
| P2 真机验证 Runtime | **codex** 与 **pi** | 两个 Runtime 用来覆盖 `loadSession`/能力差异；ADR/验收要分别记录 |
| P5 LSP | **选项 B**：自写 LSP 子集客户端（stdlib `encoding/json`） | 不引入 `go-json-experiment/json` 伪版本依赖 |
| 未知 `sessionUpdate` 变体 | P2 使用 raw handler，未知变体保留有界诊断，不猜 UI 语义 | 已有子进程测试覆盖 |

仍待确认（不阻塞 P1）：

1. P3 是否声明 `fs.readTextFile/writeTextFile`（见 `security.md` §7）。
2. P4 是否声明 `terminal/*` 能力。
3. 环境变量白名单是否包含 `SSH_AUTH_SOCK`（影响 Agent 内部 git 操作）。
