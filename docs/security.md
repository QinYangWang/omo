# 安全与可靠性（security）

> 状态：设计阶段。本文描述**要实现的边界**与**必须承认的局限**。
> 最重要的前提：**ACP 连接不等于沙箱。** 见 §1。

## 1. 信任模型（先承认局限）

| 主体 | 信任级别 | 说明 |
|---|---|---|
| IDE 自身 | 完全可信 | 它有用户权限，会写文件、起进程 |
| Workspace 内容（被打开的文件） | **不可信输入** | 文件名、内容、编码、符号链接都可能是恶意的或损坏的 |
| Agent Runtime 配置（executable/args/env） | **用户授权后可信** | 首次启动必须显式确认；之后按 `(AgentID, Workspace)` 记录信任 |
| Agent 进程本身 | **不可信行为者，但有用户级权限** | 它是普通本地进程，可读写用户能读写的一切 |
| Agent 通过 ACP 请求的能力 | **默认拒绝** | 每个请求都要用户决定 |
| Language Server | 不可信行为者（同 Agent） | 同样以用户权限运行 |

**关键事实（必须写进产品文档，不能靠 UI 暗示）**：ACP 的 `fs/*` 与 `terminal/*` 是
**「客户端为 Agent 提供的服务」**。IDE 不声明这些能力时，Agent **照旧用自己的文件 API 和
自己的 shell 写文件**——它是本机进程，IDE 拦不住。因此：

- IDE 能**保证**的是：凡是 Agent 请求 IDE 代办的读写/命令，都经过 Workspace 边界检查与权限审批。
- IDE 不能保证的是：Agent 自行改动的文件只发生在 Workspace 内。**缓解手段是检测，不是阻止**：
  文件监听会看到 Workspace 内的改动并强制 Diff 审查；Workspace 外只能靠用户的 OS 级手段
  （容器、独立用户、只读挂载）。
- 绝对不要在 UI 上宣称「Agent 被沙箱隔离」。

## 2. 文件访问边界

### 2.1 唯一入口

所有文件 IO 经过 `workspace.Service`，内部持有一个 `*os.Root`（`os.OpenRoot(workspace.Path)`）。
标准库对 `os.Root` 的保证（已核实 `go doc os.Root`）：

- 任何组件逃出根的路径都返回错误；
- 会跟随符号链接，但**符号链接不得指向根外**，**不得是绝对路径**；
- 方法可从多 goroutine 并发调用；
- 根目录被移动后仍引用原目录。

这解决了路径穿越、`../`、绝对符号链接、`symlink → /etc/shadow` 这几类问题，**不需要自研**。

**实测发现（P1）**：`os.Root` 连**绝对路径的符号链接**也拒绝，
即使它解析后仍在根内（报 `path escapes from parent`）。相对路径且不越界的链接可以正常读。
这是安全默认值的代价：某些工具生成的绝对符号链接在 IDE 里打不开。
如果将来必须支持，做法是 `filepath.EvalSymlinks` 后再用 `os.Root` 校验一次包含关系，
而不是放宽 `os.Root`。

### 2.2 追加规则（`os.Root` 不覆盖的部分）

`os.Root` 明确不阻止：文件系统边界穿越（bind mount）、`/proc` 特殊文件、Unix 设备文件。
所以还需：

1. **拒绝非普通文件**：`Stat` 后要求 `Mode().IsRegular()`（读）或「不存在/普通文件」（写）。
   拒绝 FIFO、设备、socket（否则 `ReadFile` 会永久阻塞）。
2. **大小上限**：单文件读取默认上限 8 MiB（可配），超出返回 `ErrFileTooLarge`，
   UI 提示「文件过大，以只读/不打开方式处理」。防止误开 2 GB 日志把 IDE 撑爆。
3. **规范化显示**：UI 只显示 Workspace 相对路径；发生越界请求时，日志记相对路径 + 原因，
   不把绝对路径（可能含用户名/项目名）写进遥测。
4. **写操作原子化**：临时文件（同目录、随机名、`0600`）→ `fsync` → `rename`。
   失败要清理临时文件；不允许「先截断再写」。
5. **符号链接写入**：写目标必须是 `os.Root` 内的普通文件；遇到指向根外的链接直接拒绝，
   不尝试「解析后再写」。
6. **目录遍历**：文件树懒加载，`List` 只读一层；`Ignore` 规则跳过大目录（`.git`、`node_modules`、
   `target`、`dist`），并受 `FileWatchOptions.MaxEntries` 上限保护（超限返回 `ErrWatchLimit`）。

### 2.3 外部改动的协调（可靠性，也是安全）

保存路径的实测行为（P1，`internal/documents` + `internal/workspace`）：
拿读取时的 `FileStamp`（size/哈希）去比对当前磁盘内容，不一致就返回 `ErrConflict`，
**不写盘**，由 UI 弹三选一对话框（覆盖 / 重载 / 继续编辑）。同尺寸、同 mtime 的改写也能发现，
因为最终比对的是 SHA-256 而不是时间戳。


`mygo.FileEvent` 的语义是**提示**（"treat them as hints to read the files again"），所以：

- 事件到达 → 重新 `Stat`/读取 → 与 `FileStamp` 比较 → 决定「重载 / 冲突 / 忽略」。
- 绝不做「一个事件 = 一次写」的映射：合并事件、重复事件、撤销后的事件都会发生。
- Buffer 脏且磁盘指纹变化 → 冲突对话框（覆盖 / 重载 / 保留 / 另存），不静默选边。

## 3. Agent 启动授权

1. **argv only**：`stdio.Command{Executable, Args}`，SDK 明确「never invokes a shell」。
   任何地方都不得把配置拼成字符串交给 shell（`sh -c`、`cmd /c`、`powershell -Command`）。
2. **启动前校验**：
   - `Executable` 必须能解析为绝对路径（`exec.LookPath`/`filepath.Abs`）且是可执行普通文件；
   - `Args` 不含 NUL；不展开环境变量、不做通配符展开（避免意外扩展）；
   - `cwd` 必须是当前 Workspace 根（`DirWorkspaceRoot`）或用户显式选择的目录；
   - `Env` 只允许 `KEY=value`，并且**白名单**：默认只透传 `PATH`、`HOME`/`USERPROFILE`、
     `LANG`/`LC_*`、`TMPDIR`/`TEMP`、`APPDATA`/`LOCALAPPDATA`。
     **显式禁止**透传 `SSH_AUTH_SOCK`、`GPG_AGENT_INFO`、云凭据变量、`*_TOKEN`、`*_KEY`、
     `AWS_*`、`GOOGLE_*` 等，除非用户为该 Agent 单独开启（逐项勾选）。
3. **首次信任**：`AgentDef.Trusted == false` 时，启动前弹原生确认框，展示
   **可执行文件绝对路径 + 完整 argv + cwd + 将被透传的环境变量名**。
   确认后写 `agents.trusted = 1`；路径或其内容变化（mtime/hash 变化）时**重新确认**。
4. **不自动重启**：Agent 崩溃后不自动重启（避免崩溃循环）。用户点「重启」才重启，
   且这是新进程 + 新连接（见架构 §5.3）。
5. **进程清理**：优先 `ClientProcess.Shutdown(ctx)`；Windows 子进程被放进 kill-on-close
   Job Object（SDK 实现），Unix 用进程组；IDE 退出时必须 `StopAll`，
   不让 Agent 变成孤儿进程继续写文件。
6. **Windows 无控制台窗口**：SDK 启动子进程时不再创建/显示控制台（README 明示），
   这既是体验也是避免误触用户交互。

## 4. ACP 权限请求流程

### 4.1 能力声明（诚实优先）

`InitializeRequest.ClientCapabilities` 是本项目唯一「我支持什么」的声明处：

| 字段 | MVP 值 | 理由 |
|---|---|---|
| `fs.readTextFile` / `fs.writeTextFile` | **false（P2）**；P3 视需要开 | 声明了就要实现，且每次调用都要过 Workspace 边界与审批 |
| `terminal` | **false（P2）**；P4 视需要开 | 同上；开了就要实现 `terminal/create|output|wait_for_exit|kill|release` 五个方法 |
| `elicitation` | false | 未实现 |
| `session.*` | 只声明真正实现的部分 | 未实现的能力不得声明 |

实现上的保障：`acp.ClientSideConnection` 对未实现的**可选接口**自动返回 `method-not-found`，
所以「漏声明」比「虚假声明」更安全；我们的默认值必须全 false，逐项开启。

### 4.2 审批流程

```
Agent 发起 session/request_permission
  → acpclient 转成 permissions.Request（分类 Risk，路径裁剪成相对路径，argv 预览）
  → PermissionManager.Ask(ctx, req) 阻塞
  → 主线程弹原生 Modal：标题 + 风险类别 + 受影响路径/命令 + ACP 给的选项
  → 用户点选 → Resolve(decision) → Ask 返回 → SDK 回 Agent
```

规则：

1. **默认拒绝**：对话框默认焦点在拒绝；Esc = 拒绝；关闭窗口 = 拒绝。
2. **不因超时自动授权**：`Ask` 内部的超时只能导致「拒绝/取消」，永远不能导致「允许」。
   实现上不给 `Ask` 设自动允许路径；连接断开 → 返回 error。
3. **取消即取消**：用户取消 turn 时，`CancelAll(session)` 立即把挂起请求以 `DecisionCancelled`
   结束，SDK 回 `RequestPermissionOutcomeCancelled`（ACP 规定取消时对所有挂起权限请求必须如此）。
4. **风险分类**（M2 的映射表，基于 `ToolCallUpdate` 的 `kind`/`locations`/`rawInput`）：

   | Risk | 判定 | UI 措辞 |
   |---|---|---|
   | 只读 | `kind` 为 read/search/fetch 等，且无可写位置 | 「读取」 |
   | 文件修改 | 有写/创建/删除的路径 | 「修改 N 个文件」+ 列表 |
   | 执行命令 | 含命令 argv | 「运行命令」+ 逐行 argv |
   | 其它 | 无法归类 | 「未分类请求」+ 原始摘要（脱敏、截断） |
5. **`allow_always` 收窄**：作用域 `(AgentID, WorkspaceID, Risk)`，可在设置里逐条撤销；
   不提供「永远允许任意命令」。
6. **命令预览不做 shell 转义展示**：直接显示 argv 数组（每个元素一行），
   避免用户被 `sh -c` 字符串误导。

## 5. 日志、诊断与数据保留

### 5.1 stdout 纯净化

- Agent 子进程的 **stdout 只承载 ACP 帧**；stderr 是日志通道（SDK 已如此约定）。
- IDE 自己的日志走 `log/slog` → stderr 或滚动文件，绝不打到进程 stdout（否则破坏协议）。
- IDE 不把 Agent 的 stderr 直接写进用户可见的 transcript；只进「Output / 诊断」面板。

### 5.2 脱敏

进入持久化或诊断缓冲前：

1. **路径**：Workspace 内 → 相对路径；Workspace 外 → `<external>`（不再细分，避免泄漏用户名/项目名）。
2. **命令**：保留 argv 的**程序名与前 8 个参数**，其余替换为 `…`；不保留 env。
3. **文本**：agent message/thought 只做**摘要**（前 200 字符 + 长度），不整段落库。
4. **正则清洗**：对 `(?i)(token|secret|password|api[_-]?key|authorization)\s*[:=]\s*\S+`
   替换为 `$1: <redacted>`；对 `sk-[A-Za-z0-9]{16,}`、`ghp_[A-Za-z0-9]{20,}`、
   `AKIA[0-9A-Z]{16}`、PEM 头（`-----BEGIN .* PRIVATE KEY-----`）整体替换。
5. **原始 JSON（诊断模式）**：仅当用户显式打开「诊断记录」时保存，且落盘前做 1–4；
   默认关闭。

### 5.3 有界

| 缓冲 | 上限 |
|---|---|
| 单条 ACP 帧 | SDK `ConnectionOptions.MaxFrameSize` 默认值（不透传到无界） |
| 通知队列 / 字节 | `MaxQueuedNotifications`、`MaxNotificationBytes` |
| Agent stderr 环形缓冲 | 64 KiB / 进程 |
| 诊断事件环形缓冲 | 2000 条 / 会话，超出丢最旧 |
| SQLite `agent_events` | 每会话 5000 行 + 保留 7 天，后台 `PruneEvents` |
| Diff baseline | 单文件 8 MiB、每 turn 合计 64 MiB；超限降级为 hash + 提示 |
| transcript 内存 | 只保留最近 N 条 + 可见窗口，滚动出窗口即释放 |

### 5.4 落盘内容

存：Workspace 元数据、Agent 定义与信任状态、Session 映射（含 `acp_session` 与 `can_resume`）、
UI 布局、权限授予、事件**摘要**。
**不存**：完整对话、工具输出全文、文件内容副本、Agent 的内部会话数据。
第三方 Agent 的历史归它自己；IDE 只在 `loadSession` 能力可用时请求它恢复。

## 6. 可靠性清单（与安全同级的硬要求）

| 要求 | 实现 | 验证方式 |
|---|---|---|
| Agent 崩溃不拖垮 IDE | 子进程 + 独立连接；`Done()` 驱动状态机到 `Crashed`/`Disconnected` | 假 Agent 自杀测试；真进程 kill 测试 |
| UI 卡住不影响 ACP | ACP 全在服务 goroutine；UI 只消费合并后的事件流 | `-race` + 人为阻塞 UI 测试 |
| 取消穿透到 Agent | `session/cancel` 通知 + 本地 turn 终止 | 假 Agent 挂起在 Prompt，测取消时延 |
| 断线不伪装完成 | 活跃 turn → `Unknown`；UI 明确显示「已断开」 | 连接中途关闭管道 |
| 重连后先刷新再消费 | `Restore()` 成功才继续应用事件；失败 → `Detached` | 假 Agent `loadSession=false` |
| 不自动重放副作用命令 | 断线后只允许用户手动重试；无自动重试逻辑 | 代码审查 + 测试断言无自动 Prompt |
| 退出必清理 | `App.OnQuit` → `StopAll(5s)` → 强杀 | 进程表检查（父进程退出后无孤儿） |
| 权限不因超时放行 | `Ask` 无「允许」超时分支 | 单测：超时 → `DecisionDenied`/error |

## 7. 待确认的安全决策（需要产品 owner 拍板）

1. P3 是否声明 `fs.readTextFile/fs.writeTextFile`？声明后 Agent 的所有文件访问都可被 IDE 审计，
   但会改变 Agent 的行为（有的 Agent 依赖自己的工具）。建议：先不声明，靠 watch + diff 检测。
2. P4 是否声明 `terminal`？声明意味着 IDE 要负责 PTY 生命周期、超时与退出码记录；
   建议先用 IDE 自己的终端面板（用户可见、用户自己敲），不代 Agent 执行。
3. 环境变量白名单的默认集合（是否需要 `SSH_AUTH_SOCK` 以支持 git 操作）。
4. 诊断模式默认关闭，是否需要在崩溃后自动收集一次（含脱敏后的 stderr + 最近 200 条事件）。
