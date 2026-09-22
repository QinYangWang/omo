# Pi Extension 安装、升级与运维

`omo` 的本机默认入口使用项目内置的 Pi 原生 TUI，并显式加载 omo Pi Extension；Extension 通过本机 Unix socket / Windows named pipe 连接到长期运行的 omo daemon。本页是该设置的运维手册：构成、安装与升级、版本兼容、日常运维与故障排查。架构背景见 [extension-daemon-hybrid.md](extension-daemon-hybrid.md)，快速上手见 [../packages/pi-extension/README.md](../packages/pi-extension/README.md)。

## 构成与形态

- **位置**：`packages/pi-extension/`。入口 `index.js`；私有通道客户端与纯函数助手在 `daemon-channel.mjs`。
- **形态**：纯 ESM JavaScript，由 `pi --extension <path>` 直接加载；没有构建步骤、没有运行时依赖。`packages/pi-extension/package.json` 只声明 `test:spike`，没有 `build` 也没有 `test`。
- **加载方式**：`omo` 启动原生 TUI 时用 `--extension packages/pi-extension/index.js`（`buildNativeSpawnArgs`），并向 Pi 子进程环境注入两项：
  - `OMO_DAEMON_SOCKET` — daemon 的本机 socket / pipe 路径；
  - `OMO_PI_VERSION` — launcher 解析出的项目锁定 Pi 版本。

  这两项总是以 launcher 解析值覆盖父环境同名变量；`OMO_TOKEN` 与已废弃的 spike 变量 `OMO_EXTENSION_EVENTS_URL` 不会传入 Pi 子进程。
- **职责**：Extension 只负责当前 Pi 进程——注册当前 Session、转发原生生命周期事件、接收 daemon 的 Prompt/Abort 命令并回结构化 ack。它不监听端口，不持有 TLS、公共 Bearer Token 或 workspace 路径。
- **与 headless 的关系**：`@omo/pi-runtime` 继续提供 headless runtime，Extension 只使用 Pi stable Extension API，两者并存。同一个 Session 在任一时刻只能有一个执行者（`native-attached` 或 `headless-owned`），由 daemon 的 execution broker 保证，规则见 [extension-daemon-hybrid.md](extension-daemon-hybrid.md) §4。

两个 spike 环境变量 `OMO_EXTENSION_EVENTS_URL` / `OMO_EXTENSION_COMMANDS_URL` 仍保留给 E0 live spike；daemon 模式（`OMO_DAEMON_SOCKET`）与之互相独立，launcher 只设置 daemon 模式。两者都未设置时 Extension 完全 inert（无网络、无定时器）。

## 安装与升级

### 安装

Pi 是项目锁定依赖，不需要也不允许全局安装。`omo` 通过 Node 模块解析从仓库依赖图解析 Pi，而不是 PATH：

- `resolvePiBinary()` 解析 `@earendil-works/pi-coding-agent`，读取其 `package.json` 的 `bin.pi`，校验包名与版本后返回绝对路径。
- 依赖缺失、manifest 不可读、缺少 `bin.pi` 或二进制不存在，都会在 spawn 前以可操作错误退出，提示在仓库根目录运行 `pnpm install`，并给出 `omo --legacy-tui` escape hatch。
- Extension 入口缺失时 `assertExtensionExists()` 同样失败退出。

```bash
pnpm install   # 安装项目锁定依赖（含 Pi 与 @omo/pi-runtime）
pnpm omo       # 默认本机：发现/启动 daemon，再用项目内 Pi 启动原生 TUI
```

### 版本锁策略

- **私有通道版本**：`channelVersion: 1`（`buildRegisterRequest`）。
- **Pi peer 版本锁**：`PI_PEER_VERSION = "0.86"`（`daemon-channel.mjs`），与 `cli/native-pi.mjs` 的 `EXPECTED_PI_MAJOR_MINOR = "0.86"`、`packages/pi-runtime/package.json` 中锁定的 `@earendil-works/pi-coding-agent@0.86.1` 对齐。
- **launcher 是真正的门**：`resolvePiBinary()` 调用 `assertSupportedPiVersion()`，Pi 不在 `0.86.x` 行时拒绝启动。
- **Extension 侧复核**：`checkPiPeerVersion()` 在 `OMO_PI_VERSION` 与锁不一致时只记一行日志（`pi_peer_version_mismatch: expected 0.86.x, got ...`）并让当前 Session 保持 detached-local；`OMO_PI_VERSION` 缺失时按 `"unknown"` 处理并跳过 peer 检查（launcher 已注入真实版本）。

### 升级流程（必须按顺序）

1. 修改 `packages/pi-runtime/package.json` 与根 `package.json` 中的 Pi 依赖版本，并 `pnpm install`。
2. 同步更新版本锁：`daemon-channel.mjs` 的 `PI_PEER_VERSION` 与 `cli/native-pi.mjs` 的 `EXPECTED_PI_MAJOR_MINOR`。
3. 运行兼容性验证：
   - `pnpm --filter @omo/pi-extension test:spike` — live spike，命中真实模型；
   - `pnpm test` — 仓库常规测试。
4. 全部通过后才允许发布默认切换。

`@omo/pi-extension` 故意没有 `test` 脚本，因此 `pnpm test` 不会运行 live spike。`test:spike` 需要可用的 `opencode-go` 凭据并会真实调用模型；它必须单独运行，不要与 `pnpm test` 并发运行，避免争抢 Provider 配额与互相干扰。

```bash
pnpm --filter @omo/pi-extension test:spike
pnpm test
```

## 版本兼容矩阵

| 组件 | 当前锁定值 | 定义处 |
| --- | --- | --- |
| Extension 私有通道 | `channelVersion = 1` | `packages/pi-extension/daemon-channel.mjs` |
| Pi peer 行 | `0.86`（即 `0.86.x`） | `PI_PEER_VERSION` / `EXPECTED_PI_MAJOR_MINOR` |
| Pi 依赖 | `@earendil-works/pi-coding-agent@0.86.1` | `packages/pi-runtime/package.json` |

不匹配时的行为：

- **launcher 侧**：Pi 不是 `0.86.x` 时 `assertSupportedPiVersion()` 抛错，`omo` 拒绝启动；错误信息包含实际版本、要求版本、`pnpm install` 修复方式与 `omo --legacy-tui`（或 `OMO_TUI=legacy`）。
- **Extension 侧**（例如绕过 launcher 手工设置 `OMO_PI_VERSION`）：`checkPiPeerVersion()` 记录一行 mismatch 日志，当前 Session 不注册，保持 detached-local。
- **私有通道 generation 不匹配**：视为 lease 失效并按 fencing 处理，见下文。

## 运维

### daemon 发现

- **发现记录**：`OMO_DATA_DIR/daemon.json`（由 `server/daemon-state.cjs` 管理），保存 endpoint、pid、hostId 与租约 token，**不含**访问 Token。
- **本机 endpoint**：Unix 上是 `<OMO_DATA_DIR>/run/host-<hash>.sock`，路径过长时退化为系统临时目录下的短路径；Windows 上是 `\\.\pipe\omo-<hash>`；可用 `OMO_LOCAL_SOCKET` 覆盖。
- **默认本机流程**：`omo` 读取 `daemon.json`，确认 pid 存活且 endpoint 可达后复用；否则以 detached `omo serve --socket <确定性路径>` 自动启动，等待上限 `OMO_START_TIMEOUT_MS`（默认 30000ms）。daemon 是独立 detached 进程，Pi TUI 退出不影响它。
- launcher 只接受 `unix` / `pipe` endpoint（`resolveDaemonSocket`）；daemon 发现报告 TCP endpoint 时原生路径直接失败。
- **私有 Extension 路由只在本地 socket / pipe listener 上挂载**；TCP 模式下这些路径返回 404。私有命令通道是 loopback 上的明文 HTTP/SSE，不要把它暴露给非本机。

### 心跳、租约与 generation fencing

- **注册**：每次 `session_start`（`startup`/`new`/`resume`/`fork`）POST `/api/v1/extension/register`，携带 `channelVersion: 1`、capabilities `["events","commands"]`、`instanceId`、版本与当前 `sessionId`/`sessionFile`/`cwd`。
- **凭据**：daemon 发放短期、仅内存的 `credential` 与 `generation`；Extension 从不记录 credential，也不写入 Session JSONL。
- **时间**：daemon 默认心跳间隔 5000ms、超时 15000ms（`OMO_EXTENSION_HEARTBEAT_INTERVAL_MS` / `OMO_EXTENSION_HEARTBEAT_TIMEOUT_MS`）；无论内部配置多小，对外通告的间隔与超时都不小于 1000ms（`MIN_ADVERTISED_HEARTBEAT_MS`）。
- **恢复**：Extension 按 daemon 通告值发送 `/api/v1/extension/heartbeat`；连续 3 次网络失败，或收到 401/404/409，就停止心跳、丢弃旧 generation 的事件队列，并进入一次有界重注册（500ms / 1s / 2s，最多 3 次）。重注册成功后拿到新 generation 并恢复转发。
- **fencing**：心跳、事件、ack、detach 与命令流都携带 `(instanceId, generation, credential)`。旧 generation 的迟到事件/ack 被拒绝；daemon 按 `(instanceId, generation, nativeSequence)` 去重。detach 只释放精确的 `(instanceId, generation)` 对，幂等，且不会释放更新的 generation。
- **认证状态语义**：缺失或错误 credential → `401 Unauthorized`；未知 instance → `404 Unknown instance`；generation 过期 → `409 Stale generation`。

### 事件落盘与查看

- Extension 转发的原生事件由 `server/native-events.cjs` 映射为 `{ type: <pi event name>, ...payload }`，再追加到 `EventStore`。
- **存储位置**：`OMO_DATA_DIR/omo.db`（SQLite，WAL），表 `session_events`，主键 `(session_id, sequence)`；sequence 在单个 Session 内从 1 单调递增。
- **查看渠道**：客户端 UI 或 Host SSE `GET /events?sessionId=<id>&after=<sequence>`（见 [server-api.md](server-api.md)）。也可只读查询 SQLite，写入使用 WAL，读取前不需要停 daemon：

```bash
node -e "const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.OMO_DATA_DIR + '/omo.db');
for (const row of db.prepare('SELECT sequence, type, created_at FROM session_events WHERE session_id = ? ORDER BY sequence').all('SESSION_ID')) {
  console.log(row.sequence, row.type, row.created_at);
}"
```

- **关键事件**：
  - `omo_execution_state`：execution broker 的所有权投影，payload 为 `native-attached` / `headless-owned` / `detached` 三选一。attach、detach、心跳过期各追加一条，均不含 credential。
  - `omo_error`：可操作的运行时错误。当前存在的 `code`：
    - `native_dispatch_unavailable` — Web/Desktop 的 Prompt 或 Abort 已 durable accepted，但当前没有订阅者接收命令（native owner 断开或未连接）。operation 仍算 accepted，`retryable: true`。
    - `extension_command_rejected` — native owner 回了 `rejected` ack（例如 `turn_already_running`）。daemon 只在 ack 仍属于当前 owner 时写入，迟到的 ack 不会污染新 Session。
  - 说明：turn 中断时会追加一个 `omo_error` 事件，`code: "native_turn_interrupted"`（`retryable: true`），随后是 `omo_execution_state: detached`；daemon 不会伪造 `turn_end`/`message_end`，也不会自动重复 dispatch。

### 日志位置

- **daemon**：`omo serve` 的 stdout/stderr。`pnpm restart:web`（`scripts/restart-web-server.sh`）把日志重定向到 `/tmp/omo-server.log`、pid 到 `/tmp/omo-server.pid`，可用 `OMO_LOG_FILE` / `OMO_PID_FILE` 覆盖。
- **Extension**：错误写入 Pi 子进程的 stderr，前缀 `[omo-pi-extension]`；每个进程最多 3 条（`MAX_ERROR_LOGS`），daemon 通道另有自己的 3 条错误预算。
- **launcher**：`omo` 在 stderr 打印 `omo: launching project-locked Pi <version> ...`；Pi 在 3 秒启动窗口内非零退出会额外打印启动失败提示。

## 故障排查

| 症状 | 可能原因 | 处理 |
| --- | --- | --- |
| 注册被拒 `session_already_attached`（日志一行，不重试） | 同一 Session 已有活跃 native attachment | 关闭多余的 Pi TUI；等旧 attachment 正常 detach 或心跳过期后重试 |
| 注册被拒 `headless_streaming` | daemon 内 headless runtime 正在 streaming，或已 accepted 的 Prompt 尚未 settle | 等当前 turn 结束，不要在 streaming 中抢占 |
| attach / 命令流 409 `Stale generation` | 旧 generation 的迟到请求 | 通常无需人工处理：Extension 会走心跳恢复重新注册并拿新 generation |
| 401 `Unauthorized` | credential 过期或不匹配（daemon 重启、已被 fencing） | 触发重注册；若持续 401，检查 daemon 是否刚重启、socket 是否指向同一 `OMO_DATA_DIR` |
| 404 `Unknown instance` | daemon 没有该 attachment（daemon 重启、attachment 已被回收） | 心跳路径会重注册；确认两次使用的是同一 `OMO_DATA_DIR` 与 socket |
| 心跳超时后 Session 变成 `detached` | Pi 进程崩溃/被杀，或长时间没有心跳 | 重新在本机启动 `omo`，Extension 会重新注册；daemon 不自动抢占 |
| turn 进行中 Pi 崩溃，之后没有自动重发 Prompt | 设计如此：不自动重复 dispatch | 用 `omo` 重新进入该 Session 并重新发送；历史保存在 Session JSONL |
| TUI 启动失败：版本错误 | Pi 不在 `0.86.x` 行 | 在仓库根运行 `pnpm install`；核对依赖版本与版本锁一致 |
| TUI 启动失败：缺少二进制 / extension | 依赖未安装或被删除 | `pnpm install`；恢复 `packages/pi-extension/index.js` |
| TUI 启动失败：daemon 不可达 | daemon 未启动或启动超时 | 先 `omo serve`（或 `omo --socket <path>`）确认 daemon；注意 `--legacy-tui` 连接同一个 daemon，无法绕过此失败 |
| Web 收不到 token 增量 | 先看 attach 状态：最近一条 `omo_execution_state` 是否为 `native-attached` | 若为 `headless-owned` 或 `detached`，说明 Prompt 没有走 native；检查 Pi 进程是否运行、Extension 是否注册成功 |
| 命令通道安全 | 私有通道是明文 loopback HTTP/SSE | 不要把 socket 暴露给非本机；确认它只挂在 `unix`/`pipe` listener 上 |

## 已知边界

- **Prompt 命令是纯文本**：带图片的 native Prompt 在 `promptNative` 层被拒绝（HTTP 400 `native_prompt_images_unsupported`），不会 dispatch 到 Extension。
- **ack / 事件是 best-effort**：没有 durable acceptance queue。断流对 daemon 是 unknown，Extension 不会伪造成功；accepted 但 ack 未到达时表现为静默，而不是失败。
- **busy turn 的 Prompt 被拒绝而不是排队**：`ctx.isIdle()` 为 false 时返回 `reason: "turn_already_running"`。
- **generation 变化会重置 `commandSequence`**：重注册后从 1 重新计数，旧 generation 的 in-flight 命令状态被丢弃，绝不改标到新 generation。
- **lazy Pi session file**：native Session 的 JSONL 在首条消息之后才落盘，因此在产生第一条消息前，它不会出现在 `sessions.list` / `omo session list` 中（与 headless draft 相同，见 [sessions.md](sessions.md)）。
- **对 native Session 调 `open()` 必须带 `sessionPath`**：不带时 `ensure()` 会 fail closed（`session_native_attached`），因为 live 状态由 native owner 提供，daemon 不能创建第二个 headless runtime。

## 参考

- [extension-daemon-hybrid.md](extension-daemon-hybrid.md)
- [../packages/pi-extension/README.md](../packages/pi-extension/README.md)
- [server.md](server.md)
- [client-modes.md](client-modes.md)
- [reliability.md](reliability.md)
- [sessions.md](sessions.md)
