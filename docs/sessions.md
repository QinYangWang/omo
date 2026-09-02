# 会话与消息流

## 实时同步边界

同一个 omo Server 同时服务的静态 Web 客户端和 Electron 远程桌面端共享 Server 内的 `AgentSession`、SSE 事件流、SQLite 事件日志和远程 PTY。这些客户端之间实时同步。

独立启动的 Pi TUI 进程不在该同步范围内。独立 TUI 与 omo Server 是不同的 Pi 进程实例，二者共享磁盘上的 Session JSONL，但当前没有跨进程事件广播或文件锁；外部 TUI 是否实时显示更新取决于 Pi TUI 自身是否监听文件。

Electron 本地模式也不在 omo Server 的实时同步范围内。它使用 Electron 主进程内的独立 Agent；只有选择 Electron 远程模式并连接 omo Server 时，才与静态 Web 共享同一个 Server Session。

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

已有 Session 打开后，将 Pi Message 转换为 UI Message，并按 80 项分页：

```text
第一次：最后 80 项
Load older：以当前 cursor 为终点，再向前取 80 项
```

分页只影响 React 状态。Pi SDK 的完整 Session context 不受 UI 分页影响。

## UI Message 转换

Server 的 `server/display-messages.cjs` 与 Electron 使用一致的转换规则：

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
- `message_end` 清除 streaming。
- 当前 Session 正 streaming 时，新 Prompt 使用 `streamingBehavior: "followUp"`。
- 非 streaming 时直接调用 Pi `session.prompt`。
- Abort 调用当前 Agent Session 的 `abort()`。
