# Server API

所有接口前缀为 `/api/v1`。除健康检查和静态文件外，设置 `OMO_TOKEN` 后必须携带：

```http
Authorization: Bearer <token>
```

JSON 请求体上限为 16MB。错误响应格式：

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
  "requestId": "uuid",
  "images": [
    { "type": "image", "mimeType": "image/png", "data": "base64" }
  ]
}
```

返回 HTTP 202。`requestId` 用于持久化幂等去重。`images` 可携带图片附件，最多 8 个；每个附件必须使用 `image/*` MIME 类型，base64 数据最多 8,000,000 个字符。

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

默认读取 UTF-8 文本，文件上限为 300KB。读取支持的图片扩展名为 `.png`、`.jpg`、`.jpeg`、`.gif`、`.webp` 和 `.bmp`；传入 `binary=true` 时返回：

```json
{ "data": "base64", "mimeType": "image/png" }
```

图片文件上限为 5,900,000 bytes。

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

返回 omo 内置实现（`server/quotas.cjs`）的 Provider 配额结果，覆盖 Anthropic、OpenAI Codex、GitHub Copilot、OpenRouter、Synthetic、xAI、Z.ai、OpenCode Go、Kimi Code、Ollama Cloud 10 个 Provider，带按 Provider 的 TTL 缓存。

### `GET /usage`

扫描 Pi Session JSONL，返回总 input、output、cacheRead、cacheWrite、cost，以及按 provider/model 汇总的数据。

## Skills 与 Packages

### `GET /skills`

经 Pi SDK `loadSkillsFromDir` 列出 `~/.pi/agent/skills` 下的技能（名称、描述、文件路径）。

### `GET /packages`

读取 `~/.pi/agent/settings.json` 的 `packages` 列表；npm 来源会附带 `~/.pi/agent/npm/node_modules` 中的实际安装版本。

### `POST /packages/install`

请求体 `{ "source": "npm:@scope/pkg@1.0.0" }`。仅支持 npm 来源：在 `~/.pi/agent/npm` 执行 `npm install`，然后把 source 写入 settings.json。

### `POST /packages/remove`

请求体 `{ "source": "..." }`。从 settings.json 的 `packages` 中移除。

### `GET /models`

返回可用模型列表，每项附 `enabled`。启用状态来自 settings.json 的 `enabledModels`（支持 `provider/modelId` 或裸 `modelId` 的 glob 模式；缺省为全部启用）。

### `POST /models`

请求体 `{ "enabled": ["provider/modelId", ...] }`。将启用模型写入 settings.json 的 `enabledModels`；全部启用时删除该键恢复默认。聊天页的模型选择器只显示启用的模型。

## Runtime cwd

### `GET /cwd`

返回第一个 workspace root，供远程 Files、Git 和 Terminal 面板初始化。
