# Server API

所有接口前缀为 `/api/v1`。除健康检查和静态文件外，设置 `OMO_TOKEN` 后必须携带：

```http
Authorization: Bearer <token>
```

JSON 请求体上限为 2MB。错误响应格式：

```json
{ "error": "message" }
```

## Health

### `GET /health`

返回 API 版本和能力列表。

## Projects

### `GET /projects`

返回 Server 保存的 Project 数组。

### `POST /projects`

```json
{ "cwd": "/workspace/project", "name": "optional name" }
```

`cwd` 必须已存在且位于 workspace roots 内。相同 cwd 返回已有 Project。

## Sessions

### `GET /sessions?cwd=<path>`

返回目标 Project 的 Pi Session。

### `GET /sessions/all`

返回 cwd 位于允许 workspace 内的全部 Pi Session。

### `POST /sessions/import`

```json
{ "sourcePath": "/pi/session.jsonl", "cwd": "/workspace/project" }
```

通过 `SessionManager.forkFrom` 导入 Session。

## Pi

### `POST /pi/open`

```json
{ "sessionId": "client-id", "cwd": "/workspace/project", "sessionPath": "optional" }
```

返回 UI 历史分页、Pi Session 信息和当前 event sequence。

### `POST /pi/history`

```json
{ "sessionId": "client-id", "before": 80 }
```

每次最多向前返回 80 项 UI 历史。

### `GET /pi/models`

返回 `ModelRuntime.getAvailable()` 中的模型。

### `POST /pi/model`

```json
{ "sessionId": "client-id", "provider": "provider", "modelId": "model" }
```

### `POST /pi/thinking`

```json
{ "sessionId": "client-id", "level": "max" }
```

### `POST /pi/prompt`

```json
{
  "sessionId": "client-id",
  "message": "prompt",
  "cwd": "/workspace/project",
  "sessionPath": "optional",
  "requestId": "uuid"
}
```

返回 HTTP 202。`requestId` 用于持久化幂等去重。

### `POST /pi/abort`

```json
{ "sessionId": "client-id" }
```

## Events

### `GET /events?sessionId=<id>&after=<sequence>`

返回 `text/event-stream`。服务端也读取 `Last-Event-ID` 请求头。每条 data 是：

```json
{
  "id": "event uuid",
  "sessionId": "client-id",
  "sequence": 42,
  "timestamp": 0,
  "type": "message_update",
  "payload": {}
}
```

Provider 认证事件使用保留的 `sessionId=__providers`。

## Terminals

### `POST /terminals`

```json
{ "cwd": "/workspace/project" }
```

返回：

```json
{ "terminalId": "uuid", "offset": 0, "ticket": "one-time uuid" }
```

### `POST /terminals/:id/ticket`

签发新的 30 秒一次性 WebSocket ticket。

### `WS /terminals/:id/stream?ticket=<ticket>&after=<offset>`

客户端消息：

```json
{ "type": "input", "data": "ls\n" }
```

```json
{ "type": "resize", "cols": 120, "rows": 30 }
```

服务端消息：

```json
{ "type": "output", "offset": 10, "data": "...", "nextOffset": 20 }
```

```json
{ "type": "reset", "offset": 100 }
```

```json
{ "type": "exit", "exitCode": 0, "offset": 200 }
```

## Files

### `GET /files?path=<directory>`

返回目录项，隐藏点文件和 `node_modules`。

### `GET /files/content?path=<file>`

读取 UTF-8 文本。文件上限为 300KB。

## Git

- `GET /git/status?cwd=<path>`
- `GET /git/diff?cwd=<path>&file=<relative-file>`
- `GET /git/branches?cwd=<path>`

Git 命令输出缓冲上限为 8MB。

## Providers

- `GET /providers`
- `POST /providers/login`
- `POST /providers/respond`
- `POST /providers/cancel`
- `POST /providers/logout`

登录请求体包含 `providerId` 和 `type`。respond 使用 `requestId` 与 `value`；cancel 使用 `requestId`；logout 使用 `providerId`。

## Quotas 与 Usage

### `GET /quotas?force=true|false`

返回 `@latentminds/pi-quotas` 的 Provider 配额结果。

### `GET /usage`

扫描 Pi Session JSONL，返回总 input、output、cacheRead、cacheWrite、cost，以及按 provider/model 汇总的数据。

## Runtime cwd

### `GET /cwd`

返回第一个 workspace root，供远程 Files、Git 和 Terminal 面板初始化。
