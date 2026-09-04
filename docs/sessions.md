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

## 本地生命周期

Electron 本地模式在 `electron/main.cjs` 中通过 `createAgentSession` 创建 Session。已创建的 Session 保存在主进程的 Map 中，同一个 client Session ID 复用同一个 `AgentSession`。

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

用户消息为右对齐气泡，hover 显示时间与复制按钮；assistant 完成后页脚显示耗时和复制全文按钮。Turn 尚无输出且正在 streaming 时显示「正在工作…」。

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

## 流式状态

- Assistant `message_start` 将 Session 标记为 streaming。
- `agent_end` 清除 streaming，并标记最后一个 Assistant block 的完成时间和耗时。
- streaming 期间最后一个 Turn 渲染闪烁光标与运行状态；`omo_session_file` 触发的文件同步在 streaming 期间跳过。
- 当前 Session 正 streaming 时，新 Prompt 使用 `streamingBehavior: "followUp"`。
- 非 streaming 时直接调用 Pi `session.prompt`。
- Abort 调用当前 Agent Session 的 `abort()`。
