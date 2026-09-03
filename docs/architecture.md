# 架构

## 运行形态

omo 使用同一套 React 渲染层支持三种已实现的运行形态：

1. Electron 本地模式：渲染层通过 preload IPC 调用 Electron 主进程。
2. Electron 远程模式：渲染层通过 HTTP、SSE 和 WebSocket 调用 omo Server。
3. 静态 Web：由 omo Server 托管或独立部署，并连接 omo Server。

Pi SDK 始终在执行端进程内运行。本地模式的执行端是 Electron 主进程；远程模式的执行端是 Node Server，没有 RPC 子进程。

## 代码边界

```text
electron/main.cjs           本地 Pi、Provider、Project、Session、文件、Git、终端
electron/preload.cjs        window.omo 和 window.omoSecure
server/index.cjs            HTTP、SSE、WebSocket、静态文件
server/pi-service.cjs       远程 Pi 与 Provider 生命周期
server/event-store.cjs      SQLite 事件与幂等请求
server/display-messages.cjs Pi 历史消息到 UI 消息适配
server/terminal-service.cjs 远程 PTY
server/workspace.cjs        路径边界
server/quotas.cjs           Provider 配额
server/usage.cjs            JSONL 用量聚合
src/lib/omo.ts              统一后端入口
src/lib/remote-api.ts       远程 Transport
src/App.tsx                 应用壳与面板布局
```

## 渲染层调用路径

业务组件导入：

```ts
import { omo } from "@/lib/omo"
```

`src/lib/omo.ts` 根据远程配置动态选择后端：

- 已配置 Server URL：创建并缓存 Remote API。
- 未配置 Server URL 且存在 `window.omo`：使用 Electron IPC。
- 没有 Electron preload 且未配置远程 URL：安装 `src/lib/web-preview.ts` 的预览 API。

组件不直接调用 `window.omo`，避免将 Electron IPC 绑定到业务 UI。

## 本地数据流

```text
React component
  → src/lib/omo.ts
  → window.omo
  → electron/preload.cjs
  → ipcRenderer
  → electron/main.cjs
  → Pi SDK / filesystem / git / shell
```

Pi 的 `session.subscribe` 事件通过 `webContents.send("pi:event")` 返回渲染层。Electron 本地模式只同步到当前 Electron 渲染窗口，不参与 omo Server 的跨进程事件流。

## 远程数据流

```text
React component
  → src/lib/omo.ts
  → src/lib/remote-api.ts
  → HTTP command/query
  → server/index.cjs
  → PiService / filesystem / git / TerminalService

Pi event
  → SQLite WAL
  → SSE
  → reconnect/deduplicate
  → ChatView incremental renderer
```

终端单独使用 WebSocket 双向传输，创建和重连 ticket 仍通过已认证的 HTTP 接口完成。

## Project 与 Session

Project 是执行端上的目录。Electron 本地 Project 保存在 Electron `userData/projects.json`；Server Project 保存在 `OMO_DATA_DIR/projects.json`。远程模式下 Project、Session、文件、Git、Provider 和终端都由 Server 执行。

Session 使用 Pi `SessionManager`：

- `list`：列出 Project 的 Session。
- `listAll`：列出可导入 Session。
- `create`：创建新 Session。
- `open`：打开已有 Session。
- `forkFrom`：将 Session 导入目标 Project。

历史 UI 首次渲染最近 80 项，之后按 80 项分页加载。该分页只限制 UI 数据量，不截断 Pi SDK 的上下文。
