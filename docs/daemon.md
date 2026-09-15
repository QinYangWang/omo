# omo daemon（v2，P1 进行中）

> 对应规划 [§4.1 控制面](omo-v2-plan.md)、[§13 P1](omo-v2-plan.md)、ADR-001/003。
> 本文档记录 `packages/daemon` 的已实现边界与明确的后续切片；不要把本文档当作 P1 全部交付的完成声明。

## 当前状态

P1 开门项 + 数据面切片已落地，P2 同步协议核心 + 终端已落地：

- `CommandInbox` / `InteractionStore` / `AgentRuntime` 组装为模块化 daemon 进程，HTTP 网络入口。
- Workspace 注册表 + 路径守卫；artifact 内容寻址存储；`file.save` 可靠保存（CAS + 内容对账）。
- 历史分页投影（绕过上游未实现的 `watchSession()`，§3.3.1）。
- 草稿（用户级、CAS 版本化，§6.1）。
- WSS 多路复用同步（快照 + 每订阅递增 publicationSequence + reset_required，§6.2–§6.4）。
- **终端 PTY + 输入权**：`terminal.create/kill/control` 命令、WS `terminal:<id>` 频道、单设备输入控制 + 断连移交 + force 接管（§6.6）。
- `@omo/client` TS 客户端（HTTP）+ `@omo/client/sync-client`（WSS，自动重连 + 重取快照）。
- pi-telemetry 兼容的有界 NDJSON sink（§10.3）。
- 真实 Provider 接线：默认读取 Pi `settings.json` / auth store 自动选择模型，也可显式使用 `--provider <id> --model <id>`（pi `ModelRuntime` 凭据库，§10.1）。
- **Electron 薄壳已接线**：主进程用 `DaemonSupervisor`（`electron/daemon.cjs`）托管 daemon 生命周期（启动 / 健康门 / safeStorage 令牌 / 崩溃重启 / 退出清理），renderer 经 `src/lib/omo-v2.ts` 拿到标准协议客户端；Settings 新增 Daemon 面板验证该链路。

```bash
# 默认使用 Pi settings/auth store 中的真实 provider/model：
npm run daemon -- --data-dir .omo-daemon --port 5190
# 开发冒烟才显式使用 faux：
npm run daemon -- --data-dir .omo-daemon --port 5190 --faux
# 或显式指定真实 Provider（凭据读自 pi auth store，可用 --auth-path 覆盖）：
npm run daemon -- --provider anthropic --model claude-sonnet-4-5 --workspace-root ~/code
# 配对码：--pairing-code，或环境变量 OMO_DAEMON_PAIRING_CODE，
# 或自动写入 <dataDir>/pairing-code（0600）
```

## 模块

| 模块 | 职责 |
| --- | --- |
| `src/daemon.ts` | `openDaemon()` 组装：锁 → 控制库 → 各 store → supervisor → service → artifact 孤儿清扫 → 启动对账 |
| `src/identity.ts` | `serverId` / 本地用户身份持久化；`DaemonLock` 单写者锁；`DeviceStore` 配对 / 撤销 / 认证 |
| `src/supervisor.ts` | Session → Worker 所有权映射，`ownerEpoch` 单调递增持久化，进程内唯一写者，会话级串行化，`maxWorkers` 上限 |
| `src/workspaces.ts` | `WorkspaceRegistry`：roots 内注册的 workspace + 路径守卫（realpath / 写路径父目录规范化，堵 symlink TOCTOU）；`SessionCatalog`：session ↔ workspace 绑定投影 |
| `src/files.ts` | 文件可靠保存：temp → fsync → 原子 rename → 目录 fsync → 回执（§5.8.3）；按内容对账已应用 / 未应用 / 冲突（§5.8.4） |
| `src/artifacts.ts` | 内容寻址 artifact：对象先落盘再提交元数据行；按内容幂等；读时校验 hash；启动时清扫孤儿对象 |
| `src/service.ts` | `CommandService`：命令校验（含 workspace 注册校验与 catalog 一致性）→ 持久受理（FULL 提交后才出回执）→ 异步执行；启动对账三个崩溃窗口；历史分页投影读取；Interaction 持久优先 |
| `src/sync.ts` | `SyncHub`：WSS 多路复用。频道 `daemon` / `workspace:<id>` / `session:<id>` / `terminal:<id>`；订阅即快照（cursor "0"），实时帧带每订阅递增 `publicationSequence`；慢客户端超限即 `reset_required` 并丢尾（§8.5.10）；终端输入/尺寸经客户端帧 `terminal.input/terminal.resize`（实时通道，不落盘） |
| `src/terminal.ts` | `TerminalManager`：持久终端记录（pid + 启动令牌、控制权意图、退出码）+ 易失输出尾（offset/floor 环形缓冲，落后于 floor 的读取返回 reset）；输入权单设备持有、断连可移交、force 可接管且可审计；daemon 重启将遗留 PTY 标记 `orphaned`（§8.4 默认不附着） |
| `src/events.ts` | `DaemonEventBus`：所有 store 在 FULL 提交后才发射事件；lane / terminal 事件经 watch 转发。事件是已提交事实，不是内存预览（§6.5） |
| `src/drafts.ts` | 草稿：用户级、`(userId, sessionId)` 键、revision CAS（§6.1）；不变成离线执行队列 |
| `src/telemetry.ts` | `NdjsonTelemetry`：pi-telemetry `TelemetryContext` 契约；有界轮转（`.old`），写失败静默丢弃——诊断永不拖垮业务（§10.3） |
| `src/tickets.ts` | 一次性、限时、按用途绑定的 WSS 票证；内存保存，重启即失效（§10.1） |
| `src/providers.ts` | 真实 Provider 接线：pi `ModelRuntime` 包装（凭据留在执行侧，OAuth refresh 进程内串行） |
| `src/http.ts` | `/v1` HTTP 入口 + WS upgrade 接线；Bearer 认证；JSON 1 MiB / artifact 64 MiB 上限；可选 v1 Web/API 兼容入口 |
| `src/legacy-http.ts` | 将旧 v1 Web 页面使用的 `/api/v1` 项目、会话、Pi、事件、终端、文件、Git、provider、模型、skills、packages 和 SSE 请求适配到 v2 daemon |
| `src/runtime.ts` | `createCoreDaemonRuntime()`：`CoreHarnessRuntime` 接线到 `<dataDir>/sessions/` |
| `bin/omo-daemon.ts` | 可执行入口（`npm run daemon`） |

## 数据目录

```text
<dataDir>/
  daemon.lock      单写者锁（pid + token；旧写者 PID 确认死亡才允许接管，§5.5）
  control.sqlite   命令 + Interaction + 设备 + workspace + Session 目录 +
                   所有权 + artifact 元数据 + daemon meta，单连接单提交域
                   （WAL + synchronous=FULL，读回校验）
  sessions/        每 Session 一个执行库（上游 SqliteSessionRepo 布局）
  artifacts/       内容寻址对象 objects/<sha256[:2]>/<sha256> + tmp 暂存；
                   元数据行只在对象可靠落盘之后提交（§5.8.3）
  pairing-code     自动生成的 bootstrap 配对码（0600；显式提供时不创建）
```

Workspace 注册是 fail-closed：只有规范化路径位于 `--workspace-root` /
`OMO_WORKSPACE_ROOTS`（逗号分隔，默认 cwd，与 v1 `server/config.cjs` 一致）
之内的目录才能成为 workspace；所有命令的 `scope.workspaceId` 必须是已注册
id（`unknown_workspace`），catalog 中已有归属的 session 不能跨 workspace
操作（`permission_denied`）。

## 命令契约（已实现 kind）

| kind | scope | 执行语义 |
| --- | --- | --- |
| `session.create` | workspace | 创建 Session；`operationId` = 新 Session ID；受理前崩溃可能遗留空会话（可检测、可 GC，见 §5.6 精神） |
| `prompt` | workspace+session(+lane) | 受理时固定 `operationId`；accept → admitted → drive → completed/failed/cancelled(aborted) |
| `operation.abort` | workspace+session | `expectedOperationId` CAS（与 payload 不一致即 `operation_mismatch` 拒绝）；目标 Run 自身以 `cancelled` 收尾 |
| `file.save` | workspace | payload `{path, contentText\|contentBase64, baseHash?}`；已存在文件必须带当前内容的 `baseHash`（CAS），不匹配即 `revision_mismatch` 且不落盘；落盘协议 temp → fsync → rename → 目录 fsync → 回执；同内容保存为幂等 noop；崩溃对账按文件实际内容判定已应用 / 重放 / 冲突 |
| `terminal.create` | workspace | 回执的 `operationId` 即 terminal id；payload `{shell?, cwd?, cols?, rows?, name?}`；cwd 经 workspace 守卫；崩溃恢复按持久记录判定（重启后遗留 PTY 为 `orphaned`），绝不重复 spawn |
| `terminal.kill` | workspace | SIGTERM → 宽限 → SIGKILL（pid + 启动令牌防 PID 重用，§8.4）；退出码经 onExit 落库 |
| `terminal.control` | workspace | `{action: acquire\|force\|release}`；acquire 在空闲或控制器设备断连时成功，force 总是接管（经命令审计，§6.6） |

- `expectedRevision` 目前一律 `payload_schema_unsupported` 显式拒绝（CAS 写随 P2 元数据到达），绝不静默忽略（§6.3）。
- 去重键 = principal + scope + clientMutationId；同键同 payload 返回原回执（状态可能已合法前进），同键不同 payload 409。
- 客户端断连不取消 Run：执行由 service 驱动，不依附于 HTTP 连接（P1 gate）。

## HTTP API（`/v1`，除 hello/pairing 外均需 `Authorization: Bearer`）

`--web-mode v1` 另外启用旧页面使用的 `/api/v1/*` 兼容入口；它复用同一个
Bearer device token，只在 HTTP 边界做 DTO/事件转换，不会启动第二个 runtime。

| 路由 | 说明 |
| --- | --- |
| `GET /hello` | serverId、协议版本、durability 报告（§5.8.6 启动自检） |
| `POST /pairing` | `{code, name?}` → 一次性 device token（只存 SHA-256） |
| `GET /devices` / `POST /devices/:id/revoke` | 设备列表 / 独立撤销（撤销即生效） |
| `POST /workspaces`、`GET /workspaces` | 注册（roots 内 fail-closed、按规范化路径幂等）/ 列表 |
| `GET /workspaces/:id/file?path=` | 守卫后读文件：hash + size + base64 内容（4 MiB 截断） |
| `GET /sessions?workspaceId=` | catalog 投影（session ↔ workspace 绑定） |
| `POST /artifacts`、`GET /artifacts`、`GET /artifacts/:id` | artifact 上传（裸字节，64 MiB 上限）/ 元数据列表 / 下载（读时校验 sha256） |
| `POST /commands` | 提交命令 → `202` 持久回执 |
| `GET /commands/:id`、`GET /commands?workspaceId&sessionId&laneId` | 状态 / 结果查询 |
| `POST /interactions`、`GET /interactions`、`GET /interactions/:id`、`POST /interactions/:id/answer` | 持久 Interaction：先落库后投影；单事务首答胜出 |
| `GET /sessions/:id/history?cursor&limit` | 分页历史投影：decimal-string cursor（§6.3），经持有该 Session 的 Worker 串行读取 |
| `GET/PUT /sessions/:id/draft` | 草稿读 / CAS 写（revision 不匹配 → 409 + 当前草稿） |
| `POST /sync/tickets` | 一次性 WSS 票证（30s，`sync` 用途绑定） |
| `GET /v1/sync`（WS upgrade） | 多路复用同步：客户端帧 `subscribe/unsubscribe/ping/terminal.input/terminal.resize`；服务端帧 `snapshot` / `*.updated` / `lane.event` / `terminal.output|exit|controller|created` / `reset_required` / `pong` / `error`（@omo/protocol Frame） |
| `GET /terminals?workspaceId=`、`GET /terminals/:id?after=` | 终端记录列表 / 单条 + 输出尾快照（offset/floor 语义） |
| `/api/v1/*`（仅 v1 Web 模式） | 旧 App 所需的 projects / sessions / pi / events / terminals / files / git / providers / models / skills / packages / usage 等兼容 DTO；认证仍为 device Bearer token |

错误统一 `{error: {code, message, retryable}}`，HTTP 状态由错误码映射（401/403/404/409/429/503…）。

## 同步协议（P2 核心）

- 一条 WebSocket 承载任意多订阅；客户端以 `subscriptionId + channel` 订阅。
- 每次（重）订阅：先发 `snapshot`（`publicationSequence: "0"`），实时帧从 `1` 严格递增；断连重连 = 新票证 + 全部频道重取快照（§6.4 首版允许；重放是后续优化）。
- 客户端侧同样执行序列校验：发现缺口即 `reset_required` 语义重订阅（@omo/client/sync-client 内置）。
- 草稿帧只投递给同 userId 的 session 频道订阅者；lane 帧只进 session 频道；catalog 事件进 daemon 频道。
- 终端：`terminal:<id>` 频道的快照 = 持久记录 + 输出尾（offset/floor）；落后于 floor 的读取 / 订阅返回 `reset_required`。输出是高吞吐易失流，入向持久化（§5.8 终端边界）；输入与 resize 只由控制权持有者发出（§6.6）。

## Electron 薄壳（P1 收尾 / §4.2）

- `electron/daemon.cjs` `DaemonSupervisor`：以 `ELECTRON_RUN_AS_NODE` 子进程启动 daemon；`/v1/hello` 健康门；配对码一次性换取设备令牌并以 safeStorage 落盘；崩溃重启（有界退避，默认 3 次）；退出时 SIGTERM→SIGKILL。
- Electron 默认读取 Pi 的 `settings.json`（`defaultProvider` / `defaultModel`）和本地 auth store，并将同一 auth path 传给 daemon；未配置默认模型时自动选择第一个已认证的真实 provider/model。只有显式设置 `OMO_DESKTOP_FAUX=1`（或 `OMO_DAEMON_FAUX=1`）才使用 faux。
- `electron/preload.cjs` 暴露 `omoDaemon.config()/onState()`；renderer 经 `src/lib/omo-v2.ts` 获得 `OmoClient` / `OmoSyncClient`（令牌不落 localStorage）。
- Settings → Daemon 面板展示 serverId / 状态 / WAL+FULL 持久性与 workspace/session 计数，验证 renderer→daemon 链路。
- **v2 会话面已起步**：`DaemonSessionsView`（Sidebar「v2 会话」入口；无桌面桥时提供远程 daemon 配对表单——URL + bootstrap code，§4.3 不用缓存伪装在线）完全走 daemon 协议——workspace 注册/选择、session 创建（durable command + 回执轮询）、历史分页（text / thinking 折叠块 / toolCall 卡片 / toolResult / 图片块）、prompt 带图片附件（artifactIds → 完整性校验后的 base64 → lane.accept images）、`session.configure` 改模型/思考级别（串行链上在途运行之后生效 = §6.6 下一运行边界）、草稿 400ms 防抖在线保存（§6.1）、abort（operation.abort + expectedOperationId CAS）。
- **v1 页面兼容模式**：`--web-mode v1` 恢复原来的 `App` 页面，并通过 `LegacyHttpAdapter` 将 `/api/v1` 的项目、会话、Pi prompt/history/sync、文件浏览、Git、模型、provider 登录、终端、分支/导入、skills 和 packages 映射到 v2 runtime 或 execution-side 服务。浏览器代理仍未迁移；该路由会明确返回不支持错误。

## 部署（server 形态）

- `scripts/restart-omo-daemon.sh`：与 `restart-omo-server.sh` 同约定——pkill 旧进程、`setsid` 完全脱离调用方、环境变量驱动、日志追加、立即返回。默认读取 Pi 的 `settings.json`/`auth.json` 自动选择真实 provider/model；也可用 `OMO_DAEMON_PROVIDER`/`OMO_DAEMON_MODEL` 覆盖，或用 `OMO_DAEMON_AUTH_PATH` 指定 auth 文件。只有显式设置 `OMO_DAEMON_FAUX=1` 才运行 faux。
- `scripts/restart-omo-daemon-public.sh`：公网部署入口。默认从本地 Pi settings/auth store 自动选择已认证的真实 provider/model；也可显式设置 `OMO_DAEMON_PROVIDER`、`OMO_DAEMON_MODEL`、`OMO_DAEMON_AUTH_PATH`。只有显式设置 `OMO_DAEMON_FAUX=1` 才运行 faux。每次重启删除旧 pairing code、重新生成新的 bootstrap code；code 只在脚本 stdout 打印，不写 daemon log。公网启动会用 `acme.sh` 检查证书有效期，证书缺失或在 `OMO_ACME_RENEW_BEFORE_SECONDS`（默认 30 天）内过期时先 renew/issue，再用 `--install-cert` 写入 daemon PEM 路径。域名可通过 `OMO_ACME_DOMAIN`/`OMO_DAEMON_DOMAIN`/`OMO_DOMAIN` 指定；未指定时尝试复用 acme.sh 的第一个证书。首次签发默认使用 standalone challenge，也可设置 `OMO_ACME_ISSUE_MODE=webroot|dns` 及对应参数。
- TLS：`--tls-cert/--tls-key` 或 `OMO_DAEMON_TLS_CERT`/`OMO_DAEMON_TLS_KEY`；非 loopback 监听无 TLS 时打印 §4.2 警告。域名证书（fullchain.pem + key.pem）直接用；客户端必须按域名访问（IP 直连会被主机名校验拒绝——已实测）。
- **Web 托管**：`--web-root` / `OMO_WEB_ROOT`（v1 同约定）让同一进程服务 `dist/` SPA（非 /v1 的 GET 走静态 + index.html 回退，路径逃逸被守卫）；不带 web root 时 / 依旧 404。**daemon 默认不是 web server，不配置该选项时浏览器打开根路径只会得到 404 JSON**。
- Web bundle 可通过 `--web-mode v2`（默认）使用原生 `DaemonSessionsView`，或通过 `--web-mode v1` 使用原来的 `App` / Sidebar / ChatView 页面。v1 模式仍使用 pairing code 换取可撤销 device token，并由 daemon 在 `/api/v1` 暴露兼容适配层；v2 `/v1` API 不受影响。
- `scripts/restart-omo-daemon-public.sh` 默认使用 `OMO_DAEMON_WEB_MODE=v1`，需要原生 v2 页面时设置 `OMO_DAEMON_WEB_MODE=v2`。v1 兼容层的 provider 凭据仍由 daemon 启动参数 / pi auth store 管理，不会把 pairing code 当成长期 token。
- Docker：`Dockerfile.daemon` + compose 服务 `omo-daemon`（端口 5190，`/data` 卷存控制库，`~/.pi/agent` 挂载凭据）。配对码：`OMO_DAEMON_PAIRING_CODE` 或容器内 `<data>/pairing-code`。

## 启动对账（§5.5 恢复顺序的当前实现）

daemon 打开控制库后 `service.reconcile()` 扫描所有非终态命令，按执行事实分派：

1. runtime 里 operation 仍 open → 跳过 accept，直接 drive；
2. operation 已有持久结果 → 用结果完成（绝不重跑）；
3. 两者皆无 → 受理从未落盘，用**同一 operationId** 重新 accept（上游 §3.3.3 的重复 accept 危害只存在于已 settle 的 id，已被第 2 条覆盖）；
4. `session.create` 已受理但 Session 不存在 → `outcome_unknown` 失败（§5.6 保守语义）。

覆盖测试：`packages/daemon/test/` —— `service.test.ts`（三个崩溃窗口、单写者锁、死锁 PID 接管、abort、workspace/catalog 拒绝、Interaction）+ `e2e.test.ts`（真实 CoreHarnessRuntime + faux 的完整链路 + 真实 admitted-not-driven 恢复）+ `http.test.ts`（配对 / 撤销 / 202 回执 / 回复窗口崩溃后按原 ID 对账）+ `workspaces.test.ts`（注册 fail-closed、规范化路径幂等、symlink/TOCTOU 守卫、catalog）+ `files.test.ts`（file.save CAS、三个崩溃窗口按内容对账、逃逸拒绝）+ `artifacts.test.ts`（内容寻址幂等、读时完整性、孤儿 GC、HTTP 往返）+ `sync.test.ts`（快照 + 实时帧序、断连重取快照、两端同帧序、一次性票证、草稿事件）+ `history.test.ts`（假 + 真 harness 的分页与重启一致）+ `telemetry.test.ts`（span 落盘、轮转有界、坏 sink 不影响业务）+ `terminal.test.ts`（输入权、移交、floor/reset、孤儿标记）+ `terminal-e2e.test.ts`（真实 PTY echo、两端控制权转移、kill 退出码）；Electron 薄壳由 `test/daemon-supervisor.test.mjs` 覆盖（真实 daemon 子进程 spawn / 健康门 / SIGKILL 重启后同 token 同 serverId）。

## 明确的后续切片（不属于本增量）

- Session Worker 拆分为独立 OS 进程（ADR-006/P4；所有权与 epoch 契约已就位，拆分时在写边界校验 epoch）。
- RN / RNOH 风险样机（P2；**需要指定 HarmonyOS/OpenHarmony 真机，不以 Android 兼容 APK 代替**——协议、客户端、终端通道、历史分页、文件保存均已就绪可对接）。
- 三平台服务生命周期封装（Windows 服务 / macOS LaunchAgent / Linux user service；桌面由 DaemonSupervisor 覆盖启动/退出）。
- 同步重放优化（当前断连重取快照即正确；§6.4 允许）。
- v2 会话面的剩余迁移：分支导航（绑定 base revision，§6.6）、工具执行的实时进度细节流（§6.5 provisional 预览需另行评审）。
- 文件树列举 / 搜索 / diff 投影与 artifact 引用进会话事件流。
- 终端完整输出的 artifact 落盘策略（§8.4 spill）与移动端终端尺寸协商细节。
