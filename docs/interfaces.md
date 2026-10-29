# 内部接口草案（interfaces）

> 状态：**草案，未编译**。这是设计契约，不是可运行代码；P1 落地时接口文件先于实现存在，
> 编译通过即可（实现可以是 `notImplemented` 的显式错误，不允许空实现假装成功）。
>
> 约束回顾：UI 不依赖 ACP SDK 类型；服务层不 import `ui`；一切外部调用带 `context`；
> 一切跨线程数据流走有界 channel。

## 1. 核心数据模型（与 ACP 无关）

```go
package app

type WorkspaceID string
type DocumentID string
type AgentID string
type SessionID string // IDE 内部 ID，不等于 ACP sessionId

// Workspace 是 IDE 拥有的根目录视图。Path 已规范化、已解析符号链接、已确认是目录。
type Workspace struct {
	ID   WorkspaceID
	Name string        // 文件树显示名（basename）
	Path string        // 绝对路径，规范化
	// root 是 os.OpenRoot 得到的 *os.Root，所有 IO 的唯一入口，不导出。
}

// Document 是一份编辑器文档。Buffer 是未保存内容的权威来源。
type Document struct {
	ID       DocumentID
	RelPath  string // 相对 Workspace 根，斜杠分隔，已规范化
	AbsPath  string
	Language string   // 由扩展名/内容探测，喂给 editor.SetLanguage
	Saved    FileStamp // 上次读写磁盘时的指纹
	Dirty    bool
}

// FileStamp 用于检测「我读的内容是否还是磁盘上的内容」。
type FileStamp struct {
	Size    int64
	ModTime time.Time
	Hash    [32]byte // sha256，只对 < maxHashBytes 的文件计算；更大则 Hash 为零并置 HashSkipped
	HashSkipped bool
}

// 事件：所有服务都通过这个信封上报，bounded。
type Event struct {
	At   time.Time
	Kind EventKind
	Payload any // 具体类型见各服务定义，服务内部构造，UI 只读
}
```

`editor.Buffer` 直接复用 MyGo：`editor.NewBuffer(text)`、`Buffer.Snapshot()` 返回不可变快照，
天然适配 LSP/后台只读分析（快照有 `Version()`，可做「过期结果丢弃」）。

## 2. Workspace / Document

```go
package workspace

type Service interface {
	Open(ctx context.Context, path string) (app.Workspace, error)
	Close(ctx context.Context) error
	Current() (app.Workspace, bool)

	// ReadFile 受 Workspace 根约束；返回内容与指纹。
	ReadFile(ctx context.Context, rel string) ([]byte, app.FileStamp, error)
	// WriteFile 原子写（临时文件 + rename），并返回新指纹。不做 Shell 拼接。
	WriteFile(ctx context.Context, rel string, data []byte, mode fs.FileMode) (app.FileStamp, error)
	// Stat 用于「事件 → 重读」的校验路径。
	Stat(ctx context.Context, rel string) (app.FileStamp, bool, error)
	// List 只读一层目录（懒加载）；按名字排序，目录在前。
	List(ctx context.Context, rel string) ([]Entry, error)
	// Canonical 把用户输入规范化到 Workspace 相对路径；越界返回 ErrOutsideWorkspace。
	Canonical(ctx context.Context, p string) (string, error)

	// Watch 返回合并事件流（提示语义，调用方必须重读）。
	Watch(ctx context.Context) (<-chan []app.FileEvent, error)
}

type Entry struct {
	Name  string
	IsDir bool
	Size  int64
	Mod   time.Time
}

var (
	ErrNoWorkspace       = errors.New("workspace: none open")
	ErrOutsideWorkspace  = errors.New("workspace: path outside root")
	ErrFileTooLarge      = errors.New("workspace: file too large to open")
)
```

```go
package documents

// Service 管 Buffer 的权威性与磁盘协调。所有方法都必须能在任意 goroutine 调用。
type Service interface {
	Open(ctx context.Context, rel string) (app.DocumentID, editor.Snapshot, error)
	Close(id app.DocumentID) error
	Get(id app.DocumentID) (app.Document, editor.Snapshot, bool)
	List() []app.Document

	// ApplyEdit 由主线程在用户输入后调用，让服务知道 Buffer 变了（只更新 Dirty/版本）。
	NoteEdited(id app.DocumentID, version uint64)

	Save(ctx context.Context, id app.DocumentID) (app.FileStamp, error)
	// ReloadFromDisk 放弃未保存内容（调用方已获用户确认）。
	ReloadFromDisk(ctx context.Context, id app.DocumentID) error

	// ResolveConflict 记录用户对冲突的选择。
	ResolveConflict(id app.DocumentID, choice ConflictChoice) error

	// 供 LSP/搜索使用的快照，不复制全文。
	Snapshot(id app.DocumentID) (editor.Snapshot, bool)
}

type ConflictChoice int

const (
	ConflictKeepBuffer ConflictChoice = iota
	ConflictReloadDisk
	ConflictSaveAs
)
```

`DocumentService` 与 `WorkspaceService` 分开：Buffer 生命周期以 Tab 为单位，磁盘访问以 Workspace
为单位；Diff/LSP/Git 只需要 `Snapshot`，不需要写权限。

## 3. Agent 目录与进程

```go
package agent

// AgentDef 是用户配置或内置的一条 Agent 定义。
// 启动命令永远是 executable + args 数组，绝不拼接成 shell 字符串。
type AgentDef struct {
	ID          AgentID
	Name        string
	Description string
	Executable  string   // 绝对路径或 PATH 内的名字，启动前 ResolveExecutable 校验
	Args        []string
	Env         []string // 仅 "KEY=value" 形式，白名单校验（见 security.md）
	DirMode     DirMode  // WorkspaceRoot / Home / Absolute(+Path)
	Dir         string   // DirMode==DirAbsolute 时使用
	Trusted     bool     // 用户是否显式信任过（首次启动必须为 false）
	Enabled     bool
	Version     string
	Source      string // "builtin" | "user" | path of config
}

type DirMode int

const (
	DirWorkspaceRoot DirMode = iota
	DirHome
	DirAbsolute
)

type Registry interface {
	List() []AgentDef
	Get(id AgentID) (AgentDef, bool)
	// Save 落库前必须做完整校验（executable 存在、可执行、args 不含 NUL）。
	Save(def AgentDef) error
	Remove(id AgentID) error
	SetTrusted(id AgentID, trusted bool) error
	Health(id AgentID) (Health, error) // 轻量：executable 可执行 + 最近启动结果
}
```

```go
package agent

// ProcessState 是进程状态；与 Connection / Session 状态严格分开建模。
type ProcessState int

const (
	ProcAbsent ProcessState = iota
	ProcStarting
	ProcRunning
	ProcStopping
	ProcCrashed
)

// ProcHandle 是一个已启动的 Agent 进程。连接由 acpclient 在同一生命周期内建立。
type ProcHandle interface {
	AgentID() AgentID
	PID() int
	State() ProcessState
	// Stderr 返回最近 stderr 的环形缓冲视图（有界，已脱敏）。
	Stderr() string
	// Done 在进程退出后关闭；err 给出退出原因（含退出码）。
	Done() <-chan struct{}
	Err() error
}

type ProcessManager interface {
	// Start 幂等：同一 AgentID 已在 Running 时返回既有 handle，不重复启动。
	Start(ctx context.Context, def AgentDef, cwd string) (ProcHandle, error)
	// Stop 尽力优雅（关闭 ACP 输入 → Shutdown(ctx)），超时后强杀进程树。
	Stop(ctx context.Context, id AgentID) error
	StopAll(ctx context.Context) error
}
```

进程管理不碰 ACP 语义（它是「字节流 + 生命周期」），因此可以独立测试：
用 `cat`/`sleep` 之类的假可执行文件验证启动、退出码、stderr 捕获、强杀清理。

## 4. ACPClient（唯一接触 SDK 的接口）

```go
package acpclient

// Capabilities 是协商后的能力快照。零值表示「全部不支持」——默认就是安全的。
type Capabilities struct {
	ProtocolVersion int   // 必须为 1
	LoadSession     bool
	SessionClose    bool
	SessionList     bool
	SessionResume   bool
	PromptImages    bool
	PromptAudio     bool
	EmbeddedContext bool
	McpHTTP         bool
	McpSSE          bool
	AgentName       string
	AgentVersion    string
}

// Handler 是 IDE 提供给 ACP 的回调。实现必须非阻塞或自带队列：
// SDK 在这些回调里等待返回，阻塞会拖住协议读循环。
type Handler interface {
	// Update 收到已归一化的更新；raw 保留原始 JSON（用于诊断与未知变体）。
	Update(ev Event)
	// AskPermission 必须阻塞直到用户决定、会话取消或连接关闭；
	// 返回 error 表示无法询问（连接已断/会话已取消），SDK 会向 Agent 报错。
	AskPermission(ctx context.Context, req PermissionRequest) (PermissionOutcome, error)
}

// Client 是一个已建立的 ACP 连接。一个 Client 绑定一个进程实例；
// 进程重启则连接作废，必须新建。
type Client interface {
	Capabilities() Capabilities

	Initialize(ctx context.Context, req InitializeParams) (Capabilities, error)
	NewSession(ctx context.Context, p NewSessionParams) (string, error) // 返回 ACP sessionId
	// LoadSession 仅当 Capabilities().LoadSession 为真时可用；否则返回 ErrUnsupported。
	LoadSession(ctx context.Context, sessionID string) ([]Event, error)
	Prompt(ctx context.Context, sessionID string, blocks []ContentBlock) (StopReason, error)
	// Cancel 发 session/cancel 通知；不等待 Agent 确认。
	Cancel(ctx context.Context, sessionID string) error

	Done() <-chan struct{}
	Err() error
	Close() error // 幂等
}

var ErrUnsupported = errors.New("acp: capability not supported by agent")

// Starter 负责「启动进程 + initialize + 绑定 Handler」，是测试注入点。
type Starter interface {
	Start(ctx context.Context, def agent.AgentDef, cwd string, h Handler) (Client, error)
}
```

设计要点：

- **能力默认全 false**；`ErrUnsupported` 是正常返回值，不允许「假装成功」。
- `Initialize` 返回校验过的 `Capabilities`：SDK 返回的 `protocolVersion != 1` 直接失败并关闭连接。
- `Handler.AskPermission` 阻塞是**协议要求**（它对应一个 JSON-RPC 请求），但阻塞发生在
  SDK 的 handler goroutine，不影响 UI 主线程；超时不自动授权（见 security.md）。
- `Prompt` 与 `Update` 是同一 turn 的两侧：`Prompt` 的返回给出 `StopReason`，
  update 流在中途到达，二者由 `sessions` 包用 `turnID` 关联。
- 具体 SDK 用法（已核实）：`stdio.StartClient(ctx, client, stdio.Command{Executable, Args}, acp.ConnectionOptions{})`
  返回 `*ClientProcess{Connection *acp.ClientSideConnection, Process *stdio.Process}`；
  停止用 `ClientProcess.Shutdown(ctx)`（先优雅、再强杀进程树），`Close()` 是立即停止。

## 5. Session 治理与状态机

```go
package sessions

type State int

const (
	StateNew State = iota
	StateInitializing
	StateReady
	StatePrompting
	StateStreaming
	StateAwaitingPermission
	StateCancelling
	StateDisconnected
	StateDetached // 连接在，但会话无法恢复
	StateClosed
)

// Session 是 IDE 侧的会话对象。元数据持久化，transcript 不持久化（Agent 拥有历史）。
type Session struct {
	ID          app.SessionID
	AgentID     app.AgentID
	WorkspaceID app.WorkspaceID
	ACPSession  string // 空 = 尚未创建 / 已丢失
	State       State
	TurnID      uint64 // 当前 turn，0 = 无活跃 turn
	CreatedAt   time.Time
	LastActive  time.Time
	CanResume   bool // 由 agent 能力 + 最近一次 load 结果决定
}
```

状态转移（合法转移表，非法转移返回 `ErrInvalidTransition` 并记日志）：

| From | Event | To | 副作用 |
|---|---|---|---|
| New | `beginInit` | Initializing | 建 ACP session 或 load |
| Initializing | `initOK` | Ready | 记录 `ACPSession`/`CanResume` |
| Initializing | `noSession`/`loadUnsupported` | Detached | UI 提示需新建 |
| Initializing | `connLost` | Disconnected | 标记 turn 未知 |
| Ready | `prompt` | Prompting | 分配 `TurnID`，串行化 |
| Prompting | `firstUpdate` | Streaming | 启动批次合并 |
| Streaming | `permission` | AwaitingPermission | 弹审批，挂起该 turn 的收流 |
| AwaitingPermission | `decided` | Streaming | 回 `RequestPermissionResponse` |
| Prompting/Streaming/AwaitingPermission | `promptDone` | Ready | `StopReason` 落地 |
| Prompting/Streaming/AwaitingPermission | `cancel` | Cancelling | 发 `session/cancel`；挂起权限回 `cancelled` |
| Cancelling | `promptDone(cancelled\|*)` | Ready | 迟到 update 只进诊断缓冲 |
| 任意活跃 | `connLost` | Disconnected | 活跃 turn → `Unknown`，不重放 |
| Disconnected | `reconnect+loadOK` | Initializing → Ready | 先刷新状态再消费事件 |
| Disconnected | `reconnect+loadFail` | Detached | 明示无法恢复 |
| 任意 | `close` | Closed | 若 Agent 支持 `session/close` 则调用 |

```go
type Manager interface {
	// Ensure 确保 agent 进程 + 连接 + session 就绪；必要时启动与 initialize。
	Ensure(ctx context.Context, agentID app.AgentID, ws app.Workspace) (Session, error)
	// Prompt 串行化：同一 session 有活跃 turn 时按策略排队或返回 ErrBusy。
	Prompt(ctx context.Context, id app.SessionID, blocks []acpclient.ContentBlock) (TurnResult, error)
	Cancel(ctx context.Context, id app.SessionID) error
	Close(ctx context.Context, id app.SessionID) error
	Get(id app.SessionID) (Session, bool)
	// Events 是合并后的有界流（text delta 已聚合）。
	Events() <-chan Event
	// 连接重建与会话恢复是两个独立步骤：
	Reconnect(ctx context.Context, id app.SessionID) error
	Restore(ctx context.Context, id app.SessionID) (RestoreResult, error)
}

type RestoreResult int

const (
	RestoreOK RestoreResult = iota
	RestoreUnsupported // Agent 无 loadSession 能力
	RestoreFailed
)
```

## 6. 事件归一化

```go
package events

type Kind int

const (
	KindTextDelta Kind = iota
	KindMessageCompleted
	KindThoughtDelta
	KindToolCallStarted
	KindToolCallUpdated
	KindToolCallCompleted
	KindPlanUpdated
	KindPermissionRequested
	KindPermissionResolved
	KindUsageUpdated   // 仅当协议/扩展真的提供
	KindAgentIdle
	KindAgentError
	KindSessionStateChanged
	KindUnknown        // 已识别为新变体但未建模：保留 raw，UI 折叠显示
)

type Event struct {
	Kind       Kind
	Session    app.SessionID
	Turn       uint64
	MessageID  string
	ToolCallID string
	At         time.Time

	Text  string // delta 或完成文本
	Plan  []PlanEntry
	Usage *Usage

	// Raw 只在 Kind==KindUnknown 或诊断模式下填充；有界（单条上限 + 环形缓冲）。
	Raw []byte
}
```

归一化器必须：
- 按 `(MessageID, ToolCallID)` 幂等合并重复/乱序更新；
- 把未知变体转成 `KindUnknown`（若采用 ADR-0002 的 raw 通道），否则至少记一条诊断；
- 对 `Raw` 做脱敏与截断（见 security.md）。

## 7. 权限

```go
package permissions

type Risk int

const (
	RiskRead Risk = iota // 只读
	RiskWrite            // 文件修改
	RiskExec             // 执行命令
	RiskOther            // 其它敏感能力（elicitation 等）
)

type Request struct {
	Session    app.SessionID
	ToolCallID string
	Title      string
	Risk       Risk
	Paths      []string     // 已裁剪到 Workspace 相对路径，越界的显示为「外部路径」
	Command    []string     // argv 预览，不显示拼接后的 shell 串
	Options    []Option     // 直接来自 ACP，原样呈现给用户
	RequestedAt time.Time
}

type Option struct {
	ID   string
	Kind string // allow_once / allow_always / reject_once / reject_always
	Name string
}

type Decision int

const (
	DecisionDeny Decision = iota
	DecisionAllowOnce
	DecisionAllowAlways
	DecisionCancelled
)

type Manager interface {
	// Ask 阻塞直到用户决定 / ctx 取消 / 会话取消。绝不因超时自动允许。
	Ask(ctx context.Context, req Request) (Decision, error)
	// Resolve 由 UI 调用（主线程）交付用户决定。
	Resolve(session app.SessionID, toolCallID string, d Decision)
	// 会话取消时把所有挂起请求以 DecisionCancelled 结束。
	CancelAll(session app.SessionID)
}
```

`allow_always` 的作用域必须收窄：**per (AgentID, WorkspaceID, Risk)**，写入 SQLite 并可在设置里撤销。
不做全局「永远允许执行任意命令」。

## 8. LSP（P5，接口先定形状）

```go
package lsp

type Manager interface {
	// EnsureFor 只启动当前 Workspace 实际需要的语言服务。
	EnsureFor(ctx context.Context, ws app.Workspace, lang string) error
	DidOpen(ctx context.Context, doc app.Document, snap editor.Snapshot) error
	DidChange(ctx context.Context, doc app.Document, snap editor.Snapshot) error
	DidClose(ctx context.Context, doc app.Document) error
	// 请求带版本号：过期结果由调用方丢弃（editor 诊断也带 version）。
	Completion(ctx context.Context, doc app.Document, off int, snapVersion uint64) ([]editor.Completion, error)
	Hover(ctx context.Context, doc app.Document, off int) (string, error)
	Definition(ctx context.Context, doc app.Document, off int) (app.Location, error)
	Diagnostics() <-chan DiagnosticsBatch
	Stop(ctx context.Context) error
}
```

与编辑器的接线（已核实的真实 API）：`editor.State.OnCompletion/OnHover/OnDefinition` 是回调，
LSP 结果回来后调用 `State.ShowCompletions(start, items)`、`State.ShowHover(start, end, text, build)`、
`State.SetDiagnostics(version, []editor.Diagnostic)`。**这些调用在主线程执行**（回调本身就在主线程，
异步结果必须经 `Window.Update` 回到主线程）。

## 9. Persistence

```go
package persistence

type Store interface {
	Migrate(ctx context.Context) error

	SaveWorkspace(ctx context.Context, w app.Workspace) error
	RecentWorkspaces(ctx context.Context, limit int) ([]app.Workspace, error)

	SaveAgent(ctx context.Context, d agent.AgentDef) error
	Agents(ctx context.Context) ([]agent.AgentDef, error)

	SaveSession(ctx context.Context, s sessions.Session) error
	Sessions(ctx context.Context, ws app.WorkspaceID) ([]sessions.Session, error)
	DeleteSession(ctx context.Context, id app.SessionID) error

	SaveUILayout(ctx context.Context, blob []byte) ([]byte, error) // 返回时应为最新版本
	UILayout(ctx context.Context) ([]byte, error)

	// 高频事件批量写入 + 保留策略（行数与字节双上限）。
	AppendEvents(ctx context.Context, batch []events.Event) error
	PruneEvents(ctx context.Context, keep int, maxAge time.Duration) error
	Close() error
}
```

Schema 草案（P1 落地，含 `schema_migrations` 表）：

```sql
create table if not exists schema_migrations(version integer primary key, applied_at text not null);

create table if not exists workspaces(
  id text primary key, path text not null unique, name text not null,
  last_opened_at text not null);

create table if not exists agents(
  id text primary key, name text not null, json text not null,  -- AgentDef 序列化
  trusted integer not null default 0, enabled integer not null default 1,
  updated_at text not null);

create table if not exists sessions(
  id text primary key,
  agent_id text not null references agents(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  acp_session text not null default '',
  state integer not null,
  can_resume integer not null default 0,
  created_at text not null, last_active_at text not null);

create table if not exists agent_events(   -- 仅诊断摘要，不是 transcript
  id integer primary key autoincrement,
  session_id text not null, kind integer not null, at text not null,
  summary text not null);

create table if not exists permission_grants(
  agent_id text not null, workspace_id text not null, risk integer not null,
  granted_at text not null, primary key(agent_id, workspace_id, risk));

create table if not exists ui_state(key text primary key, value blob not null);
```

**不存**：完整对话、Agent 内部消息、工具输出全文。ACP 的会话历史归 Agent；IDE 只存映射与摘要。

## 10. 命令与 UI 意图

```go
package commands

type ID string

type Command struct {
	ID      ID
	Title   string
	Key     string // 显示用；实际绑定见 keymap
	Enabled func() bool
	Run     func(ctx context.Context) error
}

// Registry 是 UI、菜单、快捷键、命令面板的唯一入口。
type Registry interface {
	Register(c Command) error
	List() []Command
	Run(ctx context.Context, id ID) error
}
```

UI 只产生意图，不直接调用服务：

```go
package app

// Intent 是视图能做的事的全部集合。
type Intent interface{ isIntent() }

type OpenFile struct{ Rel string }
type SaveActive struct{}
type RunCommand struct{ ID commands.ID }
type SendPrompt struct{ Session app.SessionID; Text string }
type CancelTurn struct{ Session app.SessionID }
type DecidePermission struct{ Session app.SessionID; ToolCallID string; Decision permissions.Decision }
type TogglePanel struct{ Panel PanelKind }
```

`app.App.Dispatch(intent Intent)` 在主线程执行（UI 回调里同步调用），它只改状态 + 投递异步任务；
真正的 IO 由 `commands` 派到服务 goroutine。

## 11. 测试用 Fake（已验证可行）

ACP 层可以**完全不用子进程**测试。实测通过的骨架（`net.Pipe` 双端 + SDK 两端的公开构造函数）：

```go
p1, p2 := net.Pipe()
agentConn, _ := acp.NewAgentSideConnectionWithOptions(fakeAgent, p1, p1, acp.ConnectionOptions{})
clientConn, _ := acp.NewClientSideConnectionWithOptions(fakeClient, p2, p2, acp.ConnectionOptions{})
```

`fakeAgent` 实现 `acp.Agent`（Initialize/Cancel/NewSession/Prompt），在 `Prompt` 里调
`agentConn.SessionUpdate(...)` 推流、调 `agentConn.RequestPermission(...)` 要权限；
`fakeClient` 实现 `acp.Client`，把 chunk 拼起来、自动选 `NewRequestPermissionOutcomeSelected("allow")`。
断言：`streamed == "hello"`、`stopReason == end_turn`、权限被问到且被作答。

同一手法的扩展（P2 要写的测试）：
- 假 Agent 在 `Prompt` 里阻塞，测 Cancel 能否穿透；
- 假 Agent 在流中途关闭管道，测 `Disconnected` 与「任务不得标记完成」；
- 假 Agent 返回 `loadSession=false`，测 `RestoreUnsupported`；
- 假 Agent 发送未知 `sessionUpdate` 变体，锁定 §9（architecture.md）的兼容行为。

UI 层同理用 `ui.NewTester(view, w, h)`：`Click`、`Type`、`Frame`、`HasText`、`Texts`、`Advance`。
实测可渲染 `Sidebar + Split + editor.View` 并断言文本，无需窗口。

## 12. 落地顺序建议

1. `app` + `commands` + `ui`（空壳布局，能开窗、能显示文件树假数据）；
2. `workspace` + `documents`（真读文件、真编辑、真保存、watcher 冲突）；
3. `terminal`（一个 Tab）；
4. `agent/catalog` + `process` + `acpclient`（先 Fake，再真进程）；
5. `agent/sessions` + `events` + `permissions`（状态机 + 审批 UI）；
6. `diff`（Diff Review + 接受/拒绝）；
7. `persistence`（迁移 + 重启恢复）；
8. 基准测试与装机脚本。

每个接口先有 Fake 实现 + 编译期 `var _ X = (*fake)(nil)` 断言，再接真实现。
