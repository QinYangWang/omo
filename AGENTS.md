# omo (oh-my-openagents)

Pi agent 的原生 Desktop 客户端（Electron）。技术栈：Electron + React 19 + Vite + Tailwind v4 + coss ui（主样式）+ ai-elements（聊天组件）+ `@earendil-works/pi-coding-agent` SDK（in-process，不走 RPC 子进程）。

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

## 开发注意

- coss 是 Base UI 风格：`render` prop 而非 `asChild`；Select 用 items-first 模式。
- ai-elements 与 coss 共享 `src/components/ui`，只保留了 5 个 ai-elements 文件（conversation/message/prompt-input/response/code-block 依赖已裁剪），不要直接 `npx ai-elements add` 全套，会冲突。
- Electron 用 `titleBarStyle: "hidden"` + `titleBarOverlay` 原生窗口键；标题栏拖拽区用内联 `style={{ WebkitAppRegion }}`，Tailwind 任意属性在 drag 区会被吞。
- 终端是裸 shell 管道（无 pty）；需要全屏交互程序时换 node-pty。

## 文档索引

- [docs/layout.md](docs/layout.md) — 页面布局设计（v3，部分已随实现演进）

## 待办

- Skills/Packages 商店真实安装（`pi install`）
- Worktree 模式与分支切换的真实执行
- ctx 上下文长度指示接 `usage` 事件
- 剩余硬编码英文文案继续收敛到 i18n 词典（Usage/Providers 细节文案）
