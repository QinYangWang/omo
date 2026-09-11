# Server API

所有接口前缀为 `/api/v1`。除健康检查、静态文件和已创建的 Browser 代理能力 URL 外，设置 `OMO_TOKEN` 后必须携带：

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

### `POST /sessions/rename`

```json
{ "path": "/pi/session.jsonl", "name": "新的会话名" }
```

### `POST /sessions/clone`

```json
{ "path": "/pi/session.jsonl" }
```

从当前叶节点创建一个新的 Session 文件，并返回其路径。

### `GET /sessions/context?path=<session-path>`

将 Session 当前分支导出为 Markdown。

### `GET /sessions/details?path=<session-path>&cwd=<path>`

返回 Session 工作目录的 Git 分支及累计 cost。

## Pi

### `POST /pi/open`

```json
{ "sessionId": "client-id", "cwd": "/workspace/project", "sessionPath": "optional" }
```

返回 UI 历史分页、完整会话 Outline 元数据、Pi Session 信息、`isStreaming` 和当前 event sequence。`cursor` 按会话轮次计数，分页不会拆开一个轮次。`outline` 的每项包含 `id`、`absoluteIndex` 和 `userPreview`，因此未加载正文的早期轮次仍可显示在大纲中。运行中的远程 Session 还会返回 `replayFromSequence`，客户端用它重放 SQLite 中当前未完成 Turn。

### `POST /pi/history`

```json
{ "sessionId": "client-id", "before": 80 }
```

每次最多返回约 80 项 UI 历史，并以会话轮次的 `cursor` 作为 `before`；不会拆开一个轮次。单个超大轮次会作为最小分页单元返回，服务端必须推进 cursor，不能返回相同 cursor 的空页。

### `POST /pi/sync`

```json
{ "sessionId": "client-id", "sessionPath": "/path/to/session.jsonl", "turnCount": 24, "tailItemCount": 3 }
```

从磁盘重读 Session 文件（TUI 同步），返回客户端缺失的部分：`fromTurn >= 0` 时用 `messages` 替换/追加从该绝对 Turn 起的内容，`-1` 表示无新增；始终返回最新 `metas`（大纲）与 `totalTurns`。Session 文件变化通过事件流中的 `omo_session_file` 事件通知。

### `GET /pi/models`

返回 `ModelRuntime.getAvailable()` 中的模型。

### `POST /pi/context-usage`

```json
{ "sessionId": "client-id", "cwd": "/workspace/project", "sessionPath": "optional" }
```

返回实时 `AgentSession.getContextUsage()`，包含 `tokens`、`contextWindow` 和 `percent`；compaction 后下一次模型响应完成前 Token 可能为 `null`。

### `POST /pi/context-details`

请求体与 `/pi/context-usage` 相同。返回当前会话的完整上下文检查快照：

- `contextUsage`：当前上下文窗口用量
- `stats`：会话累计消息、Token 与 cost
- `systemPrompt`：包含扩展逐轮修改的当前有效系统提示
- `tools`：全部工具的描述、参数 Schema、Prompt guidelines、来源与启用状态
- `resources`：上下文文件、附加系统提示、技能及来源
- `extensions`：扩展路径及其注册的事件、命令和工具
- `injectedMessages`：扩展注入且不在普通会话 UI 显示的 custom messages

该响应可能包含项目指令、工具 Schema 以及扩展注入的敏感内容，只能通过正常 Bearer Token 认证获取。客户端仅在 Context 标签可见时轮询。

### `POST /pi/model`

```json
{ "sessionId": "client-id", "provider": "provider", "modelId": "model" }
```

### `POST /pi/thinking`

```json
{ "sessionId": "client-id", "level": "max" }
```

### `POST /pi/branch`

从某个回答处切换当前 Session 的树分支，下一条 Prompt 会作为该节点的新子节点写入同一个 Session 文件：

```json
{ "sessionId": "client-id", "entryId": "session-entry-id" }
```

返回新活动分支的消息分页、Outline，以及选择用户消息时需要恢复到编辑器的 `editorText`。

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

Provider 认证事件使用保留的 `sessionId=__providers`。Session JSONL 文件被外部进程（如 Pi TUI）修改时推送 `type=omo_session_file`，payload 含文件 `path`；客户端随后调用 `POST /pi/sync` 拉取增量。

## Browser

远程 Web 客户端通过 Server 代理浏览器请求，避免客户端所在网络无法访问目标网站。打开浏览器会创建一个短期、随机 ID 的代理会话；代理页面和资源 URL 使用该 ID 作为能力凭据，因此不需要把 Server Token 放进 iframe URL。

### `POST /browser`

```json
{ "url": "https://example.com" }
```

返回：

```json
{ "browserId": "uuid", "url": "/api/v1/browser/uuid/proxy?url=..." }
```

### `POST /browser/:id/navigate`

```json
{ "url": "https://example.com/docs" }
```

返回新的代理页面 URL。Server 会在会话内保留目标站点的 Cookie。

### `GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS /browser/:id/proxy?url=<target-url>`

代理目标网站的页面、资源和表单请求。HTTP/HTTPS URL、重定向、HTML/CSS 中的相对资源链接会被转换为当前代理会话 URL。代理响应会移除阻止嵌入的 `X-Frame-Options`/CSP 响应头，并限制单次响应为 32MB。

### `DELETE /browser/:id`

关闭代理会话并清理其 Cookie。代理资源 URL 使用随机会话 ID，可在不携带 Authorization header 的 iframe 中加载；打开、导航和关闭接口仍需要正常的 Bearer Token。

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
