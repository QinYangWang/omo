# Server mode

Omo Server 在服务器进程中运行 Pi SDK，并通过 HTTP 和可恢复的 SSE 事件流供 Web 或 Electron 客户端使用。

## 本地启动

```bash
npm run build
OMO_TOKEN='replace-with-a-long-random-token' \
OMO_WORKSPACE_ROOTS='/workspace,/srv/projects' \
OMO_HOST=127.0.0.1 \
npm run server
```

默认端口为 `5189`。打开 `http://127.0.0.1:5189`，在 Settings → General 中填写 Server URL 和 Token。Electron 使用相同设置切换本地与远程模式。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OMO_HOST` | `127.0.0.1` | 监听地址 |
| `OMO_PORT` | `5189` | HTTP 端口 |
| `OMO_TOKEN` | 空 | Bearer Token；非本机部署必须设置 |
| `OMO_WORKSPACE_ROOTS` | 当前目录 | 允许访问的目录，逗号分隔 |
| `OMO_DATA_DIR` | `~/.omo-server` | 项目清单和 SQLite 事件日志 |
| `OMO_WEB_ROOT` | `dist` | Web 静态文件目录 |
| `OMO_CORS_ORIGINS` | 空 | 允许的 Web Origin，逗号分隔；空值允许请求 Origin |
| `OMO_EVENT_RETENTION` | `100000` | 每个会话保留的最大事件数 |

项目、文件、Git 和 Agent 的 cwd 都经过 realpath 检查，不能越过 `OMO_WORKSPACE_ROOTS`。

## Docker

```bash
mkdir -p projects
printf 'OMO_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env
docker compose up -d --build
```

Compose 默认只映射到 `127.0.0.1:5189`。公网使用时，应通过 Caddy 或 Nginx 提供 HTTPS，不要直接暴露 Node 端口。

## 断线恢复

每个 Agent 事件在推送前写入 SQLite WAL，并获得单调递增的 sequence。客户端保存最后 sequence，重连时发送 `after` 和 `Last-Event-ID`，服务端重放缺失事件。Prompt 使用 `requestId` 去重，客户端重试不会重复提交。

当前远程终端尚未开放；Files、Git、Projects、Sessions、Provider 和聊天事件已使用远程 Transport。终端将在独立的带 offset 重放 WebSocket 通道中实现。
