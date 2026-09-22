# 事件可靠性与幂等

## SQLite 事件日志

`server/event-store.cjs` 使用 Node `DatabaseSync`，数据库位于：

```text
OMO_DATA_DIR/omo.db
```

初始化时启用：

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
```

`session_events` 以 `(session_id, sequence)` 为主键，同时为 event ID 建立唯一约束。sequence 在单个 Session 内从 1 单调递增。

事件写入顺序为：

1. Pi `session.subscribe` 产生事件。
2. 同步写入 SQLite。
3. 通过内存 EventEmitter 通知 SSE 订阅者。

因此浏览器连接不是 Agent 生命周期的一部分。SSE 断开不会停止 Pi Session。

## SSE 重放

客户端为每个 Server 和 Session 保存：

```text
omo:event-sequence:<server-url>:<session-id>
```

连接 `/events` 时传入 `after`。Server 查询所有 `sequence > after` 的记录，按 sequence 排序重放，然后继续发送实时事件。游标超出存储队尾时（例如 SQLite 事件日志被重建后），Session 流会从头重放以重新同步客户端；保留的 `__providers` 流除外，其游标会被钳制到队尾——Provider 认证事件是临时 UI 动作，重放历史会让仅打开设置页的客户端重新打开过期的 OAuth 页面。

SSE 每 15 秒发送注释心跳，并发送 `retry: 1000`。客户端断线后按以下规则重连：

- 初始等待 1 秒。
- 每次失败翻倍。
- 最大等待 30 秒。
- 每次加入最多 20% 随机抖动。

客户端收到记录后先保存 sequence，再派发给聊天或 Provider 认证监听器。Pi 事件由 API 级长期事件桥消费，不依赖当前显示的是哪个会话，因此后台并行 Session 的 sequence 推进与 UI 状态更新保持一致。

## 运行中 Turn 恢复

`pi.open` 会返回 `isStreaming`。远程 Session 仍在运行时还会返回 `replayFromSequence`，其值位于 SQLite 中最近一次 `turn_start` 之前。新 renderer 会从持久化历史建立窗口，再把 SSE 起点回退到该位置，重新归并当前未完成 Turn 的持久化事件；这避免 Session JSONL 尚未写入完整 assistant 消息时只恢复到半截正文。

Electron 本地模式没有远程 SQLite 事件日志；同一 renderer 内的窗口切换由常驻事件桥恢复实时状态，完整重启后以 Pi Session JSONL 的持久化历史为准。

## 历史与事件边界

打开已有 Session 时，Server 从 `SessionManager.buildSessionContext()` 构造 UI 历史，并返回当前 `eventSequence`。首次连接该 Session 的客户端从该 sequence 之后订阅，避免已经进入历史的事件再次渲染。

事件保留量由 `OMO_EVENT_RETENTION` 控制，默认每个 Session 100000 条。超过保留量后，Server 每累计 1000 条执行一次旧事件清理。

## Prompt 幂等

Remote API 为每次 Prompt 生成 UUID `requestId`。Server 的 `requests` 表以 request ID 为主键保存响应。

处理流程：

1. 查询 request ID。
2. 已存在时直接返回原响应。
3. 不存在时打开或获取 Pi Session。
4. 在调用异步 Prompt 前保存响应。
5. 启动 Prompt。

### 并发重复提交（best-effort）

幂等依赖 `OperationLedger.accept()` 的 `putIfAbsent` 仓库调用；真实实现对应 `EventStore.saveRequestIfAbsent()`，执行 `INSERT OR IGNORE`，因此「查询后插入」在 SQLite 层面原子：即使多个请求同时带着同一 `requestId` 并发提交，也只有一个调用会以 `inserted=true` 插入成功并拿到 dispatch 权，其余并发调用返回同一份已持久化的 acceptance，不再次调用 `session.prompt`。

实测语义：

- 同一 `requestId` 的并发请求全部返回相同的 acceptance 结果（operationId、sessionId、sessionFile）。
- `session.prompt` 至多被调用一次，即使第一个 Prompt 仍在运行中收到重复请求也不会二次 dispatch。
- 不同 `requestId` 之间互不影响，各自独立 dispatch。

网络超时后使用同一 request ID 重试不会重复提交 Prompt。

### 已知限制：acceptance 持久化与 dispatch 之间的崩溃窗口

第 4 步（持久化 acceptance）与第 5 步（启动 Prompt）之间不是原子的。若进程在这两步之间崩溃或退出：

- `requests` 表已经包含该 requestId 的 acceptance，但 Prompt 从未真正启动（该 turn 丢失）。
- 重启后客户端用同一 `requestId` 重试会命中已持久化的 acceptance 并直接返回，而不会重新 dispatch。

这是有意的 best-effort 语义：在 dispatch 前持久化 acceptance 并以 `INSERT OR IGNORE` 原子判重，换取了「并发与重试绝不重复提交」的强保证；代价是崩溃窗口内的那一次 Prompt 会静默丢失，而不是被重放。客户端可以对比 acceptance 返回后的事件流来发现此类丢失。

## 终端恢复

终端不写入 SQLite。`TerminalService` 为活跃 PTY 保存内存环形缓冲和字符 offset。WebSocket 重连时携带最后 offset：

- offset 仍在缓冲内：补发缺失片段。
- offset 早于缓冲起点：发送 `reset`，客户端清空显示并从当前缓冲起点继续。
- 重复 output：客户端通过 `nextOffset <= currentOffset` 丢弃。
