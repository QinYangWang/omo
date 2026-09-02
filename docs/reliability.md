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

连接 `/events` 时传入 `after`。Server 查询所有 `sequence > after` 的记录，按 sequence 排序重放，然后继续发送实时事件。

SSE 每 15 秒发送注释心跳，并发送 `retry: 1000`。客户端断线后按以下规则重连：

- 初始等待 1 秒。
- 每次失败翻倍。
- 最大等待 30 秒。
- 每次加入最多 20% 随机抖动。

客户端收到记录后先保存 sequence，再派发给聊天或 Provider 认证监听器。

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

网络超时后使用同一 request ID 重试不会重复提交 Prompt。

## 终端恢复

终端不写入 SQLite。`TerminalService` 为活跃 PTY 保存内存环形缓冲和字符 offset。WebSocket 重连时携带最后 offset：

- offset 仍在缓冲内：补发缺失片段。
- offset 早于缓冲起点：发送 `reset`，客户端清空显示并从当前缓冲起点继续。
- 重复 output：客户端通过 `nextOffset <= currentOffset` 丢弃。
