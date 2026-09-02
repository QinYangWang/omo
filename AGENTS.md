# omo (oh-my-openagents)

Pi agent 的原生 Desktop 客户端（Electron）。技术栈：Electron + React 19 + Vite + Tailwind v4 + shadcn/ui（Base UI）+ ai-elements（聊天组件）+ `@earendil-works/pi-coding-agent` SDK（in-process，不走 RPC 子进程）。

## 运行

```bash
npm install
npm run dev      # Vite (端口 5188, strictPort) + Electron
npm run build    # tsc -b && vite build
```

## 架构

```
electron/main.cjs      主进程：Pi SDK 会话、Provider 认证、Project/会话列表、fs/git/终端 IPC
electron/preload.cjs   contextBridge → window.omo API
server/                 Node Server：Pi SDK、HTTP API、SSE 事件重放、文件/Git 安全边界
src/lib/omo.ts          统一 API 入口：Electron 本地 IPC 或远程 HTTP/SSE Transport
src/App.tsx            三列壳：Sidebar | Main | Right Panel（可拖拽竖线分隔）
src/components/
  Sidebar.tsx          PROJECTS + 会话列表 + 导入弹窗
  ChatView.tsx         ai-elements 会话流 + PromptInput + 模型/思考等级/上下文选择器
  RightPanel.tsx       Browser / Terminal(xterm) / Files / Review(git diff) surfaces
  SettingsView.tsx     设置壳（全屏视图，左导航）
  ProvidersSection.tsx 真实 Provider 管理（ModelRuntime login/logout）
src/types/webview.d.ts window.omo 类型 + webview 元素声明
```

- **i18n/主题**：`src/lib/i18n.tsx`（zh/en 词典 + `useI18n().t()`，localStorage `omo:lang`）与 `src/lib/theme.tsx`（dark/light/system，localStorage `omo:theme`，index.html 内联脚本防闪烁）。组件颜色一律走 CSS 变量（bg-sidebar/panel/surface/card/border…），禁止写死 hex。

## 数据流

- **会话**：Project = 本地目录（存 `userData/projects.json`）；会话经 `SessionManager.list/create/open/forkFrom` 管理。历史渲染只取当前分支最近 80 项（分页 Load older），SDK 内部保留完整上下文。
- **Provider**：`ModelRuntime` 直连。`login()` 的 text/secret/select/manual_code prompt 通过 IPC 转发为应用内 Dialog；OAuth URL 经系统浏览器打开。凭证存 Pi 的 `~/.pi/agent/auth.json`（非 omo 自建存储）。
- **配额**：接入已安装的 `@latentminds/pi-quotas`（TS 源码，主进程用 `tsx/esm/api` 注册后动态 import）。`quotas:all` 返回 10 个订阅 provider 的配额窗口；缓存策略沿用包内 TTL。
- **Token 用量**：`usage:snapshot` 扫描 pi session JSONL 聚合 usage/cost。
- **事件**：`session.subscribe` → `webContents.send("pi:event")`，渲染层按 text_delta / thinking_delta / toolcall / tool_execution_end 增量拼装。
- **限制**：消息渲染有字节/条数预算（工具参数 8KB、输出 16KB 截断），仅影响 UI，不影响 LLM 上下文。
- **Server 模式**：`npm run server` 启动远程服务；Agent 事件先写入 SQLite WAL，再经 SSE 推送并支持 sequence 重放。客户端统一通过 `src/lib/omo.ts` 访问 API，组件中不要直接新增 `window.omo` 调用。服务器文件访问必须经过 `OMO_WORKSPACE_ROOTS` realpath 校验。

## 开发注意

- UI 组件统一使用 `src/components/ui` 中的 shadcn/ui 组件；新增组件执行 `npx shadcn@latest add <component>`，项目配置见 `components.json`。
- 项目使用 shadcn/ui 的 Base UI 版本：自定义 trigger 使用 `render` prop，不使用 `asChild`；Select 使用 items-first 与对象值模式。
- ai-elements 只保留 `src/components/ai-elements` 下已裁剪的聊天组件；不要直接添加全套组件，以免覆盖共享的 `src/components/ui` 依赖。
- Electron 用 `titleBarStyle: "hidden"` + `titleBarOverlay` 原生窗口键；标题栏拖拽区用内联 `style={{ WebkitAppRegion }}`，Tailwind 任意属性在 drag 区会被吞。
- 终端是裸 shell 管道（无 pty）；需要全屏交互程序时换 node-pty。

## 文档索引

- [docs/layout.md](docs/layout.md) — 页面布局设计（v3，部分已随实现演进）
- [docs/server.md](docs/server.md) — Server 模式配置、部署与断线恢复

## 待办

- Skills/Packages 商店真实安装（`pi install`）
- Worktree 模式与分支切换的真实执行
- ctx 上下文长度指示接 `usage` 事件
- 剩余硬编码英文文案继续收敛到 i18n 词典（Usage/Providers 细节文案）
