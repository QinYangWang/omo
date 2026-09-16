# Server mode

omo Server 在服务器进程中运行 Pi SDK，并通过 HTTP、SSE 和 WebSocket 为 Electron 或 Web 客户端提供远程管理。

## 启动

通过 omo CLI 前台启动：

```bash
pnpm omo serve --host 0.0.0.0 --port 5189
```

直接运行 `pnpm omo`（或 `omo`）时默认使用本机 daemon：先按与 Host 相同的 data dir/config 读取 `daemon.json` 发现记录，确认记录的 pid 仍存活后，优先通过 Unix socket / Windows named pipe（也兼容已记录的 TCP endpoint）连接；没有存活且可达的 Host 时，会以 detached `omo serve` 子进程按确定性本机 socket 自动启动，再进入 omo TUI。`pnpm omo session list --cwd <path>` 可验证 Session 发现。

### 目标优先级

`omo` 客户端按以下优先级选择目标，越靠前越优先：

1. `--socket <path>`（显式本机 endpoint）
2. `--url <url>`（显式 Host URL）
3. `OMO_LOCAL_SOCKET`（显式本机 endpoint）
4. `OMO_URL`（显式 Host URL）
5. 默认：发现或自动启动确定性本机 daemon

只有第 5 种模式会启动 Host。显式 `--url`、`OMO_URL`、`--socket` 或 `OMO_LOCAL_SOCKET` 永远保持显式：连接失败时直接报错，不会自动启动，也不会切换到其他 Host。CLI 参数优先于环境变量；同一层内本机 socket 优先于 URL。`--token` / `OMO_TOKEN` 始终用于认证，不受目标选择影响。

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
| `OMO_TRANSPORT` | `tcp` | `tcp` 或 `socket`；`socket` 时改用本机端点，忽略 `OMO_HOST`/`OMO_PORT` |
| `OMO_LOCAL_SOCKET` | 空 | 显式 Unix socket 路径（须位于托管目录内）或 Windows named pipe；设置后默认启用 `socket` transport |
| `OMO_START_TIMEOUT_MS` | `30000` | CLI 默认本地模式等待自动启动 Host 的上限（毫秒） |
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

## 本机 transport

`OMO_TRANSPORT=socket` 时 Host 在进程内监听本机端点，而不是 TCP 端口。Unix 上默认使用 `<OMO_DATA_DIR>/run/host-<hash>.sock`；如果该路径超过 `sun_path` 长度限制，则退化到系统临时目录下由 dataDir 哈希出的短路径。Windows 上使用 `\\.\pipe\omo-<hash>` named pipe。

`OMO_LOCAL_SOCKET` 可覆盖端点，但 Unix 显式路径必须位于 `<OMO_DATA_DIR>/run` 或上述临时回退目录内；指向其他位置的路径会在创建目录或 unlink 之前直接拒绝启动。Windows pipe 名按平台规则校验。

启动时只删除经异步连接探测确认为没有 listener 的 stale socket（普通文件会拒绝覆盖，无法证明已失效时也会 fail closed）；检测到活动 listener 时以 already-in-use 失败且不会 unlink。监听后 socket 权限收紧为 `0600`，只有本进程成功绑定的 socket 才会在正常退出或失败清理时删除。

CLI 侧 `omo` 支持 `--socket <path>`（或 `OMO_LOCAL_SOCKET`）：JSON 请求与 SSE 复用同一个 `HostClient`，仅把 Node 传输换成 Unix socket / named pipe。

## 本机 daemon 发现与自动启动

默认本地模式使用与 Host 相同的配置（`OMO_DATA_DIR`、`PI_CODING_AGENT_DIR`、`OMO_WORKSPACE_ROOTS`、`OMO_TOKEN`），并在 data dir 内读取 `daemon.json`：

- 记录中 pid 存活且 endpoint 可达时直接复用；`/api/v1/health` 的 `hostId` 与记录不一致时直接失败，不会改写发现记录。
- 记录缺失、损坏或 pid 已退出时，`omo` 以 detached `omo serve --socket <确定性路径>` 子进程自动启动 Host。子进程通过 D1-002 的排他启动锁获取所有权，因此并发冷启动只会有一个 daemon 成功绑定，其余 serve 进程退出，客户端继续轮询发现记录与 health 直到成功或超时。
- 启动等待有上限（默认 30s，可用 `OMO_START_TIMEOUT_MS` 覆盖），超时错误包含 data dir 与 endpoint。detached 子进程不继承终端 stdio。
- `daemon.json` 只保存 endpoint、pid、hostId 与租约 token，不保存访问 Token；CLI 继续通过 `--token` 或 `OMO_TOKEN` 配置认证。
- 显式 `omo serve` 仍在前台运行并受同一启动锁保护。

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
