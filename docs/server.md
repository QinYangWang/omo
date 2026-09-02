# Server mode

omo Server 在服务器进程中运行 Pi SDK，并通过 HTTP、SSE 和 WebSocket 为 Electron 或 Web 客户端提供远程管理。

## 启动

```bash
npm install
npm run build
OMO_TOKEN='replace-with-a-long-random-token' \
OMO_WORKSPACE_ROOTS='/workspace,/srv/projects' \
OMO_HOST=127.0.0.1 \
npm run server
```

开发 watch 模式：

```bash
npm run server:dev
```

## 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `OMO_HOST` | `127.0.0.1` | 监听地址 |
| `OMO_PORT` | `5189` | HTTP 与 WebSocket 端口 |
| `OMO_TOKEN` | 空 | Bearer Token |
| `OMO_WORKSPACE_ROOTS` | 当前工作目录 | 允许访问的目录，逗号分隔 |
| `OMO_DATA_DIR` | `~/.omo-server` | Project 清单与 SQLite |
| `OMO_WEB_ROOT` | `dist` | 静态 Web 目录 |
| `OMO_CORS_ORIGINS` | 空 | 允许的跨域 Origin |
| `OMO_EVENT_RETENTION` | `100000` | 每 Session 保留事件数 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi 数据目录 |

## Web 托管

Server 可直接返回 `dist`。返回 HTML 时注入：

```js
window.__OMO_SERVER_URL__ = location.origin
```

因此 Web 自动使用当前 omo Server。独立部署 Web 时，在 Settings → General 填写 Server URL 和 Token，并为 Server 配置 `OMO_CORS_ORIGINS`。

## Docker

```bash
mkdir -p projects
cp .env.example .env
# 修改 .env 中的 OMO_TOKEN
docker compose up -d --build
```

Compose 默认映射 `127.0.0.1:5189:5189`，并挂载：

- `./projects` → `/workspace`
- `omo-data` → `/data`
- `${HOME}/.pi/agent` → `/root/.pi/agent`

## 运行时行为

- Pi 事件写入 SQLite WAL 后通过 SSE 发送。
- 同一个 omo Server 服务的静态 Web 和 Electron 远程客户端共享 Server 内 Agent，并实时同步。
- 独立 Pi TUI 和 Electron 本地模式使用不同 Pi 进程实例，只共享磁盘 Session JSONL，不提供跨进程实时事件同步。
- SSE 客户端使用 sequence 恢复缺失事件。
- Prompt 使用 request ID 幂等。
- 远程终端使用 node-pty、一次性 WebSocket ticket 和 offset 重放。
- 文件、Git、Project cwd 和终端 cwd 必须位于 workspace roots。
- Session JSONL 只允许位于 Pi sessions 目录。

详细接口见 [server-api.md](server-api.md)，恢复机制见 [reliability.md](reliability.md)，安全边界见 [security.md](security.md)。
