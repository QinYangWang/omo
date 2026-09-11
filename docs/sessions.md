# 会话与消息流

## 实时同步边界

同一个 omo Server 同时服务的静态 Web 客户端和 Electron 远程桌面端共享 Server 内的 `AgentSession`、SSE 事件流、SQLite 事件日志和远程 PTY。这些客户端之间实时同步。

Electron 本地模式不在 omo Server 的实时同步范围内。它使用 Electron 主进程内的独立 Agent；只有选择 Electron 远程模式并连接 omo Server 时，才与静态 Web 共享同一个 Server Session。

## TUI 会话同步

独立启动的 Pi TUI 与 omo 是不同的 Pi 进程实例，二者共享磁盘上的 Session JSONL。omo 通过文件监听实现单向同步（TUI → omo）：

- Server（`server/pi-service.cjs`）和 Electron 主进程在 `pi.open`（或 draft 首次 prompt 落盘）时对 Session JSONL 挂 `fs.watch`（去抖 250ms，按文件大小变化去重），变化时向事件流追加 `omo_session_file` 事件。
- 客户端收到该事件后去抖 300ms 调用 `pi.sync(sessionId, sessionPath, turnCount, tailItemCount)`：服务端从磁盘重建快照，与客户端已知的 Turn 数比较：
  - 文件 Turn 数更多 → 返回 `fromTurn = turnCount` 及之后全部消息（客户端追加）；
  - Turn 数相同但尾部 Turn 更长 → 返回 `fromTurn = totalTurns - 1`（客户端替换最后一个 Turn）；
  - 否则返回 `fromTurn = -1`，仅刷新大纲元数据。
- 本地 streaming 期间跳过同步（本进程 Agent 的输出由事件流覆盖），streaming 结束后文件落盘触发的 sync 作为兜底校准。
- `pi.sync` 同时刷新服务端分页快照，后续 `pi.history` 使用最新数据。

反向同步（omo → TUI）取决于 Pi TUI 自身是否监听文件。

## Draft 会话落盘

新建会话先以无 `sessionPath` 的 draft 形式存在，Pi 在首次 prompt 时才创建 Session JSONL。`pi.prompt` 会立即返回 `{ sessionFile, sessionId }`（不等待 Agent 完成）：客户端据此把 draft 绑定到真实文件——标题栏显示首条用户消息，侧栏高亮进入该会话行。由于 JSONL 通常要等首条 assistant 消息才写入磁盘（可能延迟数秒），客户端每秒轮询 `sessions.list` 直到新会话出现在列表中（上限 15 次）。

## 本地生命周期

Electron 本地模式在 `electron/main.cjs` 中通过 `createAgentSession` 创建 Session。已创建的 Session 保存在主进程的 Map 中，同一个 client Session ID 复用同一个 `AgentSession`。ChatView 挂载时 retain 会话，卸载时 release；已完成且持续空闲的本地 Agent 默认在 15 分钟后 `dispose()`，运行中的 Agent 不会被回收，完成后重新进入空闲倒计时。再次进入已回收 Session 时从 JSONL 重建 Agent context。可通过 `OMO_SESSION_IDLE_MS` 调整空闲时间（最小 60 秒）。

Session 使用的工具根据平台选择：

- Windows：`read`、`powershell`、`edit`、`write`、`grep`、`find`、`ls`
- 其他平台：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`

Prompt 在异步 Pi 任务中执行；IPC 只返回 Session 信息，消息通过事件流返回。

## 远程生命周期

`server/pi-service.cjs` 与 Electron 使用同一个 `createAgentSession` 生命周期。Server 为每个 client Session ID 缓存创建 Promise，避免并发请求创建重复 Agent。

打开 Session 时：

- 带 `sessionPath`：先由 `SessionManager.open` 读取持久化历史，再异步连接 Agent。
- 不带 `sessionPath`：通过 `SessionManager.create(cwd)` 创建新 Agent Session。

远程 Session 的 cwd 和 Session path 分别经过 workspace 与 Session root 边界检查。

## 历史分页

已有 Session 打开后，沿当前分支读取全部持久化的 Pi Message，转换为 UI Message，并按 80 项分页：

```text
第一次：最后约 80 项（只在会话轮次边界切页）
Load older：以当前轮次 cursor 为终点，再向前取约 80 项
```

分页只影响 React 状态。Pi SDK 的完整 Session context 不受 UI 分页影响。打开时会额外返回整条会话的大纲元数据，因此未加载正文的早期轮次也可以出现在 Outline 中。

服务端先沿当前分支创建一次 history snapshot：UI Message、每个 Turn 的起始消息位置和完整 `TurnMeta` 都来自同一份快照。分页 cursor 表示 Turn 数量，不表示原始 Pi Message 数量；如果单个 Turn 本身超过页面大小，第一页仍会完整包含它并推进 cursor，避免返回空页或重复请求。

## Turn 聚合与虚拟列表

`src/lib/conversation-turns.ts` 以每条 user message 作为边界，将 Pi Message 聚合为 `ConversationTurn`：

```ts
interface ConversationTurn {
  id: string
  absoluteIndex: number
  user: UserMessage
  items: ChatMessage[]
}
```

同时维护轻量 `TurnMeta`：

```ts
interface TurnMeta {
  id: string
  absoluteIndex: number
  userPreview: string
}
```

Outline 直接基于 `TurnMeta` 生成，不依赖 DOM 查询。正文使用 React Virtuoso 的可变高度列表，一个 Turn 是一个虚拟列表 item。`startReached` 自动向前 prepend 更早历史，并由 Virtuoso 保持现有滚动位置；不再显示分页按钮。

`TurnWindow.start` 和 `startCursor` 保存当前正文窗口在完整会话中的绝对起点；加载更早页面时按服务端 cursor prepend，并保留完整 Outline 元数据。点击 Outline 节点时，先按 `TurnMeta.absoluteIndex` 加载到目标所在窗口，再等两个 animation frame（Virtuoso 完成数据摄入与高度重测）后滚动。

Virtuoso 设置了 `firstItemIndex={start}`，其公开 API（`scrollToIndex`、`rangeChanged`、`itemContent` 的 index）全部使用绝对坐标：跳转必须传 `start + 窗口内下标`，读取可见范围时用 `range.startIndex - start` 换回窗口下标。跳转交给 Virtuoso 内建的 `scrollTargetReached` 重试，不做二次矫正滚动；距离 ≤5 Turn 用 smooth，远距离用 `behavior: "auto"` 并加 `offset: -8` 呼吸边距。跳转期间用 token 忽略过期跳转、抑制 `startReached` 级联分页、暂停 `followOutput`；目标 Turn 立即获得高亮（用户气泡 `bg-accent` + 外层 `ring-primary/40`，约 1.6s 后淡出）。

## 大纲（Outline）

`src/components/chat/outline.tsx` 是基于 `TurnMeta` 的章节迷你地图，不依赖 DOM 查询：

- 每条用户消息对应一个刻度，最多同时显示 24 条；可见窗口使用迟滞策略——active 章节仍在窗口内时不重排，越界才做最小位移，点击可见刻度不会引起刻度跳动。
- 刻度按钮是固定的 12×40px 命中区，包裹 1px 高的视觉线；hover 时线变长。
- hover 预览用 shadcn HoverCard（portal 渲染，不受容器裁剪）展示用户消息前 300 字符。
- 三种状态：未激活（w-4、`muted-foreground/40`）、hover（w-10、`muted-foreground`）、当前章节（w-6、`bg-primary`）。
- 在刻度区域滚轮每次移动一个 Turn，滚轮事件不会继续滚动消息列表。
- 顶部预加载关闭，避免上一条仅部分可见的 Turn 抢占 active 状态；底部保留预加载以减少向下滚动等待。

## Turn 渲染（TurnCard）

`src/components/chat/turn-card.tsx` 直接消费 display message（`ConversationTurn.items`），将会话内连续项聚合为 segment：

- **markdown**：assistant 文本，React Markdown 渲染；streaming 时在最后一个 segment 末尾显示闪烁光标。
- **thinking**：默认折叠为一行状态条（Collapsible）。运行中显示「正在思考…」脉冲 + spinner；完成后显示「思考过程」，点击展开内容。
- **tools**：连续的 tool 项聚合为一个折叠块，标题为「N 次工具调用」；运行中实时显示当前工具名 + spinner，有失败显示失败计数（destructive）。展开后每个工具是独立的二级折叠行（名称 + 输入摘要 + 状态图标），再展开查看 input/output。

用户消息为右对齐气泡，hover 显示时间与复制按钮。Assistant 区域顶部是一条 Marker 状态行（`role="status"`，border 变体带底部分割线）：运行中显示 Spinner +「Working for …s / 已工作 …s」实时计时（以用户消息时间戳为起点每秒刷新），完成后显示真实耗时 `durationMs`；悬停、点击与展开状态均无背景，仅文字在 `muted-foreground` 与 `foreground` 间切换。

点击状态行展开活动列表（与状态行左对齐，无竖线）：思考、连续聚合的工具调用、以及工具调用之间的中间输出文本。只有 Turn 最后一段 assistant 文本作为正文渲染；中间说明文本折叠进活动列表，以 TextIcon + 首行摘要展示，点击展开完整 Markdown。思考与工具子项再点击展开详情（thinking 内容、工具 input/output）。Assistant 完成后页脚只有复制全文按钮和分支按钮（耗时已并入状态行）；分支按钮通过 `AgentSession.navigateTree()` 将活动叶节点移动到该回答，下一条 Prompt 在同一 Session JSONL 中形成新分支。Turn 尚无输出且正在 streaming 时，状态行本身就是「Working…」指示。

打开历史会话时，若 Session 未在运行但存在缺少 toolResult 的工具调用（例如 agent 进程在工具返回前被中断），这些 dangling 工具会被标记为 error 并附中断说明，避免一直显示 running。

## Pi RenderBlock adapter

`src/lib/pi-adapter.ts` 将 Pi SDK message/event 标准化为 RenderBlock（`markdown` / `reasoning` / `tool-call` / `error`），用于把 streaming event 应用到当前 Turn 的 display items。`src/components/chat/render-blocks.tsx` 提供 `MarkdownBlock` 和错误块渲染。

- user：提取字符串或 text parts。
- assistant text：生成 `role: "assistant"`。
- assistant thinking：生成 `role: "thinking"`。
- tool call：生成 `role: "tool"`，初始状态为 running。
- tool result：按 tool call ID 写回 output 和状态。

Electron 本地历史还会在 Assistant turn 结束时设置：

- `turnEnd`
- `completedAt`
- `durationMs`
- `copyText`

显示截断边界：

- user text：80KB
- assistant text：100KB
- thinking：40KB
- tool input：8KB
- tool output：16KB

截断结果只用于 UI，不写入 Pi Message。

## 增量事件

ChatView 处理已实现的事件：

- `message_start`
- `message_update`
- `thinking_start`
- `thinking_delta`
- `thinking_end`
- `text_start`
- `text_delta`
- `toolcall_start`
- `toolcall_delta`
- `toolcall_end`
- `tool_execution_start`
- `tool_execution_end`
- `message_end`
- `turn_start`
- `turn_end`
- `omo_error`

text 和 thinking delta 追加到当前 Session 最后一个对应消息；tool call delta 追加输入；tool execution end 写入 output、状态和耗时。

## 并行会话与流式状态

Agent 生命周期不属于 `ChatView`。执行端以 client Session ID 缓存独立的 `AgentSession`，因此多个 Session 可以并行运行；切换路由、工作区面板或 React 组件挂载状态不会取消 Prompt。

渲染层使用 `${serverId}:${sessionId}` 作为隔离键，维护每个 Session 的 Turn window、streaming 状态和输入草稿。每个后端 API 只安装一个长期事件桥，事件先按 Session ID 写入对应缓存，再通知当前可见的 `ChatView`；不可见 Session 的 delta 不会被丢弃。重新进入会话时组件从缓存恢复，而不是继承上一个会话的输入框或 streaming 状态。文本草稿同时写入 localStorage，图片和文件附件仅保留在当前 renderer 内存中，避免把文件内容持久化到浏览器存储。

- Assistant `message_start` 将对应 Session 标记为 streaming。
- draft 首次 Prompt 返回持久化 `sessionId` 和 `sessionFile` 后，`session-streaming.ts` 将这两个标识绑定为 client Session key 的别名；侧栏同时按 ID 与路径读取状态，因此多个并行新会话都能显示各自的 Spinner。
- `agent_end` 只清除对应 Session 及其别名的 streaming，并标记其最后一个 Assistant block 的完成时间和耗时；手动 Abort 或 Prompt 失败也立即清除状态，并把仍为 running 的 thinking block 标记完成。
- streaming 期间仅该 Session 最后一个 Turn 渲染闪烁光标与运行状态；`omo_session_file` 触发的文件同步在该 Session streaming 期间跳过。
- 当前 Session 正 streaming 时，新 Prompt 使用 `streamingBehavior: "followUp"`。
- 非 streaming 时直接调用 Pi `session.prompt`。
- Abort 按 Session ID 调用对应 Agent Session 的 `abort()`。
