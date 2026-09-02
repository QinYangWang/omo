# omo (oh-my-openagents)

omo 是 Pi Agent 的 Electron Desktop 与 Web 客户端。项目使用 Electron、React 19、Vite、Tailwind CSS v4、shadcn/ui（Base UI）、React Virtuoso、React Markdown，以及 in-process 的 `@earendil-works/pi-coding-agent` SDK。

## 运行

```bash
npm install
npm run dev          # Vite 5188 + Electron
npm run build        # tsc -b && vite build
npm start            # Electron
npm run server       # omo Server，默认 127.0.0.1:5189
npm run server:dev   # omo Server watch 模式
```

## 核心约束

- 业务组件统一通过 `src/lib/omo.ts` 访问后端，不要直接新增 `window.omo` 调用。
- `components.json` 使用 `base-rhea`，UI 底层组件为 Base UI；自定义 trigger 使用 `render` prop。
- Pi Agent 在本地 Electron 主进程或 omo Server 进程内运行，不使用 RPC 子进程。
- Server 的 Project、Agent、文件、Git 和终端路径必须位于 `OMO_WORKSPACE_ROOTS` 内。
- 组件颜色使用语义化 CSS 变量。

## 文档索引

- [docs/architecture.md](docs/architecture.md) — 运行形态、代码边界、本地与远程数据流
- [docs/client-modes.md](docs/client-modes.md) — Electron 本地/远程、静态 Web、safeStorage 与连接配置
- [docs/server.md](docs/server.md) — omo Server 启动、配置、托管与 Docker
- [docs/server-api.md](docs/server-api.md) — HTTP、SSE 和 WebSocket API 参考
- [docs/reliability.md](docs/reliability.md) — SQLite 事件、SSE 重放、Prompt 幂等与终端恢复
- [docs/security.md](docs/security.md) — Token、workspace、Session path、WebSocket ticket 与凭据边界
- [docs/sessions.md](docs/sessions.md) — Pi Session 生命周期、Turn 聚合、RenderBlock 适配、虚拟列表与实时同步边界
- [docs/terminal.md](docs/terminal.md) — 本地 shell 与远程 PTY、缓冲、重连和回收
- [docs/providers-usage.md](docs/providers-usage.md) — Provider 认证、配额和 Token 用量
- [docs/ui.md](docs/ui.md) — UI 组件约定、三列布局、代码块、会话大纲与 surface
- [docs/layout.md](docs/layout.md) — 当前页面布局结构
- [docs/deployment-testing.md](docs/deployment-testing.md) — 构建、已实现验证、Docker 和数据卷
