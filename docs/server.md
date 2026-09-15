# Server mode

omo Server 在服务器进程中运行 Pi SDK，并通过 HTTP、SSE 和 WebSocket 为 Electron 或 Web 客户端提供远程管理。

## 启动

通过 omo CLI 前台启动：

```bash
pnpm omo serve --host 0.0.0.0 --port 5189
```

直接运行 `pnpm omo` 会连接 `OMO_URL`（默认 `http://127.0.0.1:5189`），本机默认 Host 不存在时自动启动，再进入 omo TUI。远程 Host 可传 `--url` 与 `--token`；`pnpm omo session list --cwd <path>` 可验证 Session 发现。

现有 Server 脚本仍可直接使用：

```bash
pnpm install
pnpm build
OMO_TOKEN='replace-with-a-long-random-token' \
OMO_WORKSPACE_ROOTS='/workspace,/srv/projects' \
OMO_HOST=127.0.0.1 \
pnpm server
```

开发 watch 模式：

```bash
pnpm server:dev
```

## 手机访问本地 Web

Desktop 不可用时，优先让 omo Server 直接托管构建后的 Web。这样 Web 与 API 同源，不需要额外配置 CORS：

```bash
cp .env.example .env
# 设置强 OMO_TOKEN；远程网络建议同时配置 OMO_TLS_CERT/OMO_TLS_KEY
pnpm restart:web
```

`restart:web` 参考 `/root/restart-omo-server.sh`：先构建 Web，再使用 `setsid` 在后台启动 Server，强制监听 `0.0.0.0:5189`，PID 和日志默认写入 `/tmp/omo-server.pid` 与 `/tmp/omo-server.log`。为了避免把无认证 Agent 暴露到网络，未设置 `OMO_TOKEN` 时脚本会拒绝启动。

仅开发前端时可运行 `pnpm dev`，Vite 监听 `0.0.0.0:5188`。它不等同于安全的远程部署；手机长期访问应使用带 Token 和 HTTPS 的 Server 托管页面。

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
| `OMO_TLS_CERT` | 空 | TLS 证书路径（PEM），与 `OMO_TLS_KEY` 一起设置后启用 HTTPS |
| `OMO_TLS_KEY` | 空 | TLS 私钥路径（PEM） |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi 数据目录 |

## HTTPS

默认监听 HTTP。同时设置 `OMO_TLS_CERT` 与 `OMO_TLS_KEY` 后，HTTP API、SSE 与终端 WebSocket（WSS）全部走同一个 TLS 端口：

```bash
OMO_TLS_CERT=/path/to/cert.pem OMO_TLS_KEY=/path/to/key.pem pnpm server
```

只设置其中一个或文件不可读时 Server 拒绝启动并提示。可用 mkcert 为局域网地址签发受信任证书；自签名证书需要各客户端手动信任，否则浏览器与 Electron 远程模式会拒绝连接。启用 HTTPS 后客户端的 Server URL 相应改为 `https://`。

## Web 托管

Server 可直接返回 `dist`。返回 HTML 时注入：

```js
window.__OMO_SERVER_URL__ = location.origin
```

因此 Web 自动使用当前 omo Server。首次打开会进入引导页，输入该 Server 的 Token 登录后才会进入（Token 存 localStorage）。独立部署 Web 时，在 Settings → Servers 添加 Server URL 和 Token，并为 Server 配置 `OMO_CORS_ORIGINS`。

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
- JSON 请求体上限为 16MB；文本文件最多 300KB，图片文件最多 5,900,000 bytes。
- Prompt 最多接收 8 个图片附件，每个附件的 base64 数据最多 8,000,000 个字符。

详细接口见 [server-api.md](server-api.md)，恢复机制见 [reliability.md](reliability.md)，安全边界见 [security.md](security.md)。
