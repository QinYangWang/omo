# 客户端模式与连接配置

客户端通过 `src/lib/servers.ts` 管理服务器列表。每个服务器（本机或远程）都有独立的 `omoApi` 实例，Project、Session、文件、Git、Provider、Pi Agent 和终端调用按所属服务器路由。

## 本机服务器

- **Electron**：preload 暴露 `window.omo`，Pi Agent 在本地主进程内运行，无需登录。
- **omo Server 托管的 Web**：Server 返回 `index.html` 时注入 `window.__OMO_SERVER_URL__ = location.origin`，同源 API 即本机 Agent。首次打开进入引导页，输入该 Server 的访问令牌登录；Token 以保留 id `local` 存于 localStorage，之后直接进入（Server 未设 `OMO_TOKEN` 时探测直接通过，无引导页）。

纯静态 Web（独立部署、非 Server 托管）没有本机服务器，只能添加远程服务器。

## 引导页

非 Electron 客户端在以下情况进入引导页（`src/components/OnboardingGate.tsx`）：

- 托管 Web：带本地存储 Token 探测同源 `/api/v1/cwd` 失败（未登录或 Token 失效）。
- 静态 Web：未配置任何远程服务器。

引导页提供“登录当前服务器”（托管 Web，URL 预填只需 Token）和“添加远程服务器”两个入口。Electron 与 localhost 开发预览不显示引导页。

## 远程服务器

Settings → Servers 支持添加、编辑、删除多个远程服务器，并周期性检测各服务器状态（在线/离线/延迟）。

- Electron：服务器列表经 `window.omoSecure` IPC 存入 userData 的 `remote-server.json`，Token 由 `safeStorage.encryptString()` 加密。旧版单服务器配置在读取时自动迁移为列表。
- Web：服务器列表保存在当前 Origin 的 localStorage（`omo:servers`），旧版 `omo:server-url` / `omo:server-token` 自动迁移。

跨域部署需要在 Server 设置 `OMO_CORS_ORIGINS`。HTTPS 页面连接远程服务时，远程服务也必须使用 HTTPS/WSS，避免浏览器混合内容限制。

## 项目与会话路由

新建项目时在对话框中选择目标服务器（本机或任一远程服务器）。`Project.serverId` 标记项目归属，客户端将不同服务器的项目聚合到同一边栏列表，并以 `serverId:projectId` 作为复合 ID。远程项目的会话列表与导入均通过该项目所属服务器的 API 完成。

`getServerApi(serverId)` 返回该服务器的缓存 API 实例；`omo` 代理仍指向默认服务器（本机优先，否则第一个远程），供窗口控制等全局调用使用。

## 浏览器开发预览

没有 Electron preload、没有 `__OMO_SERVER_URL__` 且未配置任何远程服务器时，`src/lib/web-preview.ts` 提供预览数据，使 Vite 页面可以独立检查 UI。该预览不执行真实 Pi、文件、Git 或终端操作。
