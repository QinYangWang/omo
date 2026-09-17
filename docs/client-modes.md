# 客户端模式与连接配置

客户端通过 `src/lib/servers.ts` 管理服务器列表。每个服务器（本机或远程）都有独立的 `omoApi` 实例，Project、Session、文件、Git、Provider、Pi Agent 和终端调用按所属服务器路由。

M1-001 起，服务器列表的目标模型是客户端本地 Host registry（`@omo/contracts` 的 `HostRegistryEntry` / `HostRegistryDocument`）：条目只含 `id`、`label`、`endpoint`、可选 `expectedHostId` 与可选 `credentialRef`。条目 `id` 是客户端本地 registry 条目 id，与 Host health 的 `hostId`（持久化的 Host 安装/数据目录身份，Host 进程重启后不变）不是同一个概念；registry 本身不保存 Bearer Token，Token 仍由各客户端的凭据适配器（Electron `safeStorage`、Web localStorage）持有。CLI 与浏览器各自维护自己的 registry，不会自动互相同步。endpoint 支持 `http`/`https` URL 与 `unix`/`pipe` 本机 transport；浏览器只能使用前两者，托管或静态 Web 必须拒绝本机 socket/pipe。

M1-002 在 `@omo/client-core` 落地共享的 `HostConnectionManager`：它接收 `CredentialResolver` 与 `createClient(entry, token)` 工厂，对每个 registry entry 独立做 health 探测并产出以 `entryId` 为键的 `HostConnectionSnapshot`（`idle`/`checking`/`online`/`offline`/`unauthorized`/`credential-error`/`identity-mismatch`）。Token 只经工厂传入，不进入快照、错误消息、日志或序列化；无 `credentialRef` 为匿名，存在但无法解析为显式 `credential-error`。首次成功 health 返回 `entryUpdate` 供调用方持久化 `expectedHostId`；mismatch 为隔离失败，绝不改写条目。Web 与 CLI 各自提供自己的 `createClient`（浏览器 HTTP、Node socket/pipe）与凭据解析器，`client-core` 不导入平台模块。

M1-003 已接入平台凭据持久化、registry store、选中 entry、状态订阅与切换 UI：CLI 使用 `OMO_DATA_DIR/host-registry.json` 与 `env:<NAME>` 凭据引用；Web/Electron 使用 registry 文档加独立凭据 vault（Electron 经 `safeStorage`，浏览器为 localStorage 且不声称安全）。两个客户端都把 `HostConnectionManager` 用于远端 health/身份固定与每 Host 独立状态，一个 Host 离线/401/身份不匹配不会阻断其他 Host。

## CLI Host registry

CLI 在 `OMO_DATA_DIR/host-registry.json` 维护独立的版本化 registry（`schema: "omo.host-registry"`、`version: 1`），与 `daemon.json` 分离，使用临时文件 + rename 原子写入且权限 `0600`。registry 只含 `id`、`label`、`endpoint`、可选 `expectedHostId`、可选 `credentialRef`，不含 Token。命令：

```bash
omo host list
omo host add --name <label> --url <http(s)://...> [--credential-env <ENV_NAME>]
omo host remove <entryId>
omo host use <entryId|local>
omo --server <entryId> [session list | TUI]
```

- `--url` 只接受 HTTP/HTTPS；同一归一化 endpoint 不允许重复；未知 entryId、非法环境变量名、损坏/非法 registry 文件都是硬错误，损坏文件不会被静默重置。
- `--credential-env` 只持久化不透明引用 `env:<NAME>`；Token 在连接时从进程环境解析，不写入 registry。
- 连接优先级（高到低）：显式 `--socket`/`--url`/`OMO_LOCAL_SOCKET`/`OMO_URL` > `--server <entryId>` > registry 的 `selectedEntryId` > 本机 daemon 发现/自动启动。`--server local` 是一次性本机覆盖。显式 transport 完全不读写 registry。
- 只有本地模式会启动 Host；`omo host ...` 元数据命令不连接也不启动 Host；选中的远端失败不会回退到本机。
- 连接 registry entry 时使用 `HostConnectionManager` 做 health 与身份校验；首次成功会原子写入 `expectedHostId`，身份不匹配/凭据缺失/离线分别为可操作的错误，且不改写选择或其他条目。

## CLI UI 模式

E3-001/E3-002 起，`omo` 本机默认进入带 omo Pi Extension 的 Pi 原生 TUI。原简化 omo TUI 保留为本机回退路径（`--legacy-tui` / `OMO_TUI=legacy`），并始终用于显式远程选择器以及 registry 中显式选中的远端 Host。

选择优先级（高到低）：

1. **显式远程选择器**：`--socket`、`--url`、`--server`，或环境变量 `OMO_LOCAL_SOCKET`、`OMO_URL`（即上节连接优先级里所有非本机默认的情况）→ 简化 omo TUI，不启动原生 Pi。显式远程选择器与 `--native` 组合是硬错误。
2. `--native` → 本机 Pi 原生 TUI。
3. `--legacy-tui` → 本机简化 omo TUI；与 `--native` 组合是硬错误。
4. `OMO_TUI=legacy` → 本机简化 omo TUI；`OMO_TUI=native` 等价于默认。其它非空值（包括大小写不同的写法）是硬错误，错误信息列出 `"native"` 与 `"legacy"` 两个合法值。显式 `--native` / `--legacy-tui` 优先于该环境变量。
5. **本机默认**（无远程选择器、无上述 flag、无 `OMO_TUI`）→ 先解析客户端 registry（`OMO_DATA_DIR/host-registry.json`，见 `cli/host-registry.mjs` 的 `selectedRegistryHostIsRemote`）：若 `selectedEntryId` 指向的 entry endpoint 为远端（`http`/`https`），沿用简化 omo TUI，保证 `omo host use <entry>` 的显式选择不被默认值静默覆盖；若选中的是本机 entry（`unix`/`pipe`）或没有有效选中项 → Pi 原生 TUI。registry 文件缺失、损坏或 schema 非法，以及悬空的 `selectedEntryId`，都视为“无远端选中项”并回退到本机原生 TUI（registry 只是客户端便利设施，不是启动本机 TUI 的硬依赖），不会因此崩溃。

本机默认与 `--native` 的流程：先发现或启动本机 daemon（同一 `OMO_DATA_DIR` 下的 `daemon.json` 与 Unix socket / Windows named pipe），然后用项目锁定依赖中的 Pi 启动原生 TUI，并显式 `--extension packages/pi-extension/index.js`。子进程环境只注入两项：`OMO_DAEMON_SOCKET`（daemon 的 socket/pipe 路径）与 `OMO_PI_VERSION`（锁定的 Pi 版本）。这两项总是以 launcher 解析出的值覆盖父环境中的同名变量；`OMO_TOKEN` 与 E0-004 的 `OMO_EXTENSION_EVENTS_URL` 都不会传入子进程。Pi 退出不影响已 detached 的 daemon。

`omo session list`、`omo session new`、`omo host ...` 与 `omo serve` 保持原有行为，不受默认 UI 模式影响。原生 TUI 启动失败、daemon 不可达与 Pi 版本不兼容的可操作错误和安全回退属于 E3-003，本阶段不声称在失败时自动回退到简化 TUI。

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

Settings → Servers 支持添加、编辑、删除多个远程服务器，并周期性检测各服务器状态（在线/离线/需要认证/凭据错误/身份不匹配/延迟）。列表使用 `selectedEntryId` 标记全局默认 Host，"Use" 按钮写入该选择；`getServerApi()` 不传 `serverId` 时解析到默认 Host。项目仍通过显式 `Project.serverId` 路由，切换默认 Host 不会给已有项目或 Session 重新打标。选择失效时按列表首项确定性回退且不删除条目。

- Electron：registry 文档与凭据 vault 经 `window.omoSecure` IPC 存入 userData 的 `remote-server.json`。Token 由 `safeStorage.encryptString()` 加密在独立的 `credentials` 字段中，registry 文档本身不含 Token。旧版 `{ servers: [...] }` 与单服务器格式在渲染层一次性迁移为新结构。
- Web：registry 存于当前 Origin 的 localStorage key `omo:host-registry`，Token 存于独立的 `omo:credentials` vault key；旧版 `omo:servers` 与 `omo:server-url`/`omo:server-token` 在首次读取时单向迁移并删除。浏览器只能配置 HTTP/HTTPS endpoint，`unix`/`pipe` 会被拒绝。注意：静态 Web 的 vault 只是同源 localStorage，同源脚本可读取，不具备密钥保护；Electron 才使用 `safeStorage`。
- 迁移是单向且幂等的；同一 endpoint 只保留一个条目，保留的托管 Web `local` 记录会变成合成本地凭据而不是 registry 条目。

跨域部署需要在 Server 设置 `OMO_CORS_ORIGINS`。HTTPS 页面连接远程服务时，远程服务也必须使用 HTTPS/WSS，避免浏览器混合内容限制。远程 Workspace 的 Browser 由 omo Server 代理目标网站；代理会话的短期随机 URL 可被 iframe 加载，不会暴露 Server Token。

## 项目与会话路由

新建项目时在对话框中选择目标服务器（本机或任一远程服务器）。`Project.serverId` 标记项目归属，客户端将不同服务器的项目聚合到同一边栏列表，并以 `serverId:projectId` 作为复合 ID。远程项目的会话列表与导入均通过该项目所属服务器的 API 完成。

`getServerApi(serverId)` 返回该服务器的缓存 API 实例；`omo` 代理仍指向默认服务器（本机优先，否则第一个远程），供窗口控制等全局调用使用。

## 浏览器开发预览

没有 Electron preload、没有 `__OMO_SERVER_URL__` 且未配置任何远程服务器时，`src/lib/web-preview.ts` 提供预览数据，使 Vite 页面可以独立检查 UI。该预览不执行真实 Pi、文件、Git 或终端操作。
