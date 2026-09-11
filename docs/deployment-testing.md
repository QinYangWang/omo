# 验证与部署

## 本地验证

仓库已实现以下验证命令：

```bash
npm run check
npm run build
git diff --check
```

`check` 执行 Ultracite/Biome 检查；`build` 执行 TypeScript 项目构建和 Vite 静态构建。

Server 相关脚本使用 Node 语法检查：

```bash
node --check server/index.cjs
node --check server/pi-service.cjs
node --check server/event-store.cjs
node --check server/display-messages.cjs
node --check server/pi-context.cjs
node --check server/usage.cjs
node --check server/terminal-service.cjs
node --check server/browser-service.cjs
node --check server/quotas.cjs
node --check server/workspace.cjs
node --check electron/main.cjs
node --check electron/preload.cjs
```

## 已实现的行为验证

已验证的行为包括：

- Server 健康检查。
- Bearer Token 对业务 API 返回 401。
- Project 添加与列表。
- 文件列表和文本/图片文件大小限制。
- Server 托管 Web 自动注入当前 Origin。
- SQLite 事件 sequence 重放。
- Prompt request ID 幂等记录和图片附件校验。
- Provider 配额接口返回各 Provider 的订阅窗口。
- 远程 PTY 输入输出。
- 服务器端 Browser 代理页面、重定向和 HTML/CSS 资源。
- Context 详情接口返回实时窗口用量、累计 cost、有效系统提示、工具和扩展资源；本地 IPC 与远程 HTTP 结构一致。
- WebSocket 断开后通过 offset 补发终端输出。

## Electron 性能与内存

桌面端遵循 Electron 性能清单，启动路径只加载窗口与 IPC 所需代码：Pi SDK、Provider quota、usage 和 agent config 在首次调用时加载；Settings 与 Workspace 使用动态 import，Workspace 内的 diff、Shiki 和 xterm 不进入初始 renderer chunk。生产构建的初始 JS 从约 1.87 MB 降至约 0.78 MB（未压缩），Workspace 独立为按需 chunk。

BrowserWindow 禁用默认菜单与拼写检查，保持后台节流，并显式启用 sandbox、context isolation、关闭 node integration。窗口在 `ready-to-show` 后显示。renderer 最多保留 12 个非运行会话的正文窗口和附件草稿缓存；文本草稿仍由 localStorage 持久化。Electron 主进程会回收 release 后空闲的已完成 Agent，默认超时 15 分钟：

```bash
OMO_SESSION_IDLE_MS=300000 npm start
```

运行中 Agent 不受 UI 切换和空闲回收影响。诊断实际占用时应分别查看 Electron Task Manager/Chrome Memory 中的 main、renderer、GPU、utility 与 webview 进程；打开 Workspace 浏览器标签会创建额外 Chromium renderer，这是预期的进程隔离成本。

## Server 启动

```bash
npm run build
OMO_TOKEN='<long-random-token>' \
OMO_WORKSPACE_ROOTS='/workspace,/srv/projects' \
OMO_HOST=127.0.0.1 \
npm run server
```

开发 watch 模式：

```bash
npm run server:dev
```

## Docker

构建：

```bash
docker build -t omo .
```

或使用 Compose：

```bash
mkdir -p projects
printf 'OMO_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env
docker compose up -d --build
```

镜像包含前端构建产物、生产依赖、Server 源码和 node-pty 编译工具链。默认端口为 5189。

Compose 默认：

```yaml
ports:
  - "127.0.0.1:5189:5189"
```

该配置只接受宿主机本地连接。使用反向代理暴露服务时，由代理终止 HTTPS。

## 数据卷

Compose 使用：

```yaml
volumes:
  - ./projects:/workspace
  - omo-data:/data
  - ${HOME}/.pi/agent:/root/.pi/agent
```

对应数据：

- `/workspace`：项目和终端默认 cwd
- `/data`：Project 清单与 SQLite 事件日志
- `/root/.pi/agent`：Pi Session、认证凭据和 Pi 配额数据

`.env.example` 提供可配置环境变量的格式，不包含真实 Token。
