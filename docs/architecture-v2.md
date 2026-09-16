# omo v2：精简执行架构

> 状态：当前已实现执行基线。Pi Extension + daemon 的下一阶段目标、所有权状态机与任务 Gate 见 [`extension-daemon-hybrid.md`](extension-daemon-hybrid.md)；在对应 Gate 通过前，本文描述的 Host-owned runtime 仍是生产行为。

## 1. 当前目标

omo v2 只先解决一个问题：**一个 Host 内运行的 Pi Session，能够被 CLI TUI 与 Web 同时操作和观察。**

首个 gate 必须证明：

1. `omo serve` 启动唯一 Agent 执行端；
2. CLI TUI 和 Web 连接同一 Host、同一 Session；
3. 任一客户端发送 Prompt，另一个客户端实时看到结果；
4. 客户端断线不会终止 Session；
5. SSE 重连能按 sequence 补齐事件；
6. 重复 `requestId` 不会在同一 Host 进程中重复提交 Prompt；
7. 用户无需全局安装 Pi，也不依赖 Desktop。

在这个 gate 通过前，不实现统一 WebSocket、Pi experimental v2、移动端原生应用、HarmonyOS、RBAC、extension migration 或 Session worker。

## 2. 非目标与可靠性边界

当前阶段明确不承诺：

- exactly-once operation；现有 `requestId` 只提供 durable acceptance 去重，Host 在“记录接受”与“实际 dispatch”之间崩溃时仍可能需要人工重试；
- 多 Host 聚合视图；M1-001 只定义 registry 条目语义，M1-003 只做客户端本地切换，不做聚合；
- 一个 Host 的多个 endpoint 自动合并；多个 endpoint 只能是互相独立的别名；
- endpoint fallback、聚合缓存与重试状态机；M1-002 只实现 credential reference、共享探测与每 entry 错误域；M1-003 接入持久化、选中与切换；
- snapshot/revision 协议；当前只使用 HTTP 查询与 SSE sequence 重放；
- 跨 Host Session 迁移；
- Pi experimental server/client/protocol 的稳定兼容；
- Desktop、iOS、Android 或 HarmonyOS 客户端。

这些限制必须体现在 API、测试和文档中，不能用 capability flag 宣称尚未接入的能力。

## 3. 最小拓扑

```text
CLI TUI ── HTTP + SSE ──┐
                        ├── omo Host ── in-process Pi SDK
Web ───── HTTP + SSE ───┘
```

约束：

- Host 是 Project、Session、Pi runtime、event log 与 operation record 的唯一所有者；
- CLI 和 Web 都不得创建第二份 Agent runtime；
- 本地与远程暂时使用同一套 HTTP/SSE API；
- Terminal 继续使用现有 WebSocket，不为了“单连接”提前重写；
- Desktop 保持现状，但不进入首个 gate。

## 4. 只保留三个边界

### 4.1 `@omo/contracts`

只包含当前 `/api/v1` 实际使用的请求、响应和 SSE event schema。Schema 在网络边界校验，不为尚不存在的协议预建 DTO。

### 4.2 `HostClient`

`@omo/client-core` 当前只负责一个 transport-neutral `HostClient`：

```ts
interface HostClient {
  health(): Promise<HostHealth>;
  listProjects(): Promise<Project[]>;
  listSessions(cwd: string): Promise<SessionSummary[]>;
  openSession(command: OpenSessionCommand): Promise<SessionSnapshot>;
  prompt(command: PromptCommand): Promise<AcceptedOperation>;
  abort(command: AbortCommand): Promise<void>;
  subscribeSession(
    sessionId: string,
    afterSequence: number,
    listener: (event: AgentEventEnvelope) => void
  ): () => void;
}
```

HTTP/SSE、认证 header 和重连属于该实现。React state、localStorage、TUI component 和平台 credential storage 不进入这个包。

Host registry 的稳定语义见 4.3，连接/凭据模型见 4.4；在其之上抽取 store 与切换 UI 仍然延后。

### 4.3 Host registry 与多 endpoint 语义

M1-001 只定义客户端本地 registry 的稳定语义，不实现 store、切换 UI、凭据存储、重试或迁移框架。

- **所有权**：Host 是唯一的执行所有者，永远不知道客户端 registry。registry 是客户端本地配置；CLI（profile/数据目录）与浏览器（localStorage/托管凭据）可以使用不同持久化实现，二者不会自动同步。一个 registry 只描述“这个客户端如何到达若干 Host”。
- **条目身份**：`HostRegistryEntry.id` 是客户端本地 registry 条目 id，由客户端生成且稳定；健康检查返回的 `hostId` 则是 Host 安装/数据目录的持久身份（由 `server/host-identity.cjs` 持久化在数据目录的 `host.json`，Host 进程重启后保持不变），二者是不同概念，不要求相等。`expectedHostId` 可选，只在成功 health 后固定，用于检测同一 endpoint 后续被另一个 Host 安装替换；Host 重启后 `hostId` 不变，属于匹配而非 mismatch。
- **endpoint**：使用 discriminated union。`http`/`https` 是 URL（trim、host 小写、去默认端口、剥离 fragment/query 与末尾 `/`，并拒绝带 userinfo 的 URL）；`unix`/`pipe` 是本机路径（Unix 绝对路径，Windows 完整 `\\.\pipe\<name>`）。浏览器只能使用 `http`/`https`，不得使用 socket/pipe；纯静态或托管 Web 必须拒绝本机 transport。
- **条目字段**：`id`、`label`、`endpoint`、可选 `expectedHostId`、可选 `credentialRef`。registry 永远不保存 Bearer Token 或其他凭据材料；`credentialRef` 只是指向平台 keystore/safeStorage 的不透明引用。
- **重复语义**：同一 registry 内以“归一化后的 endpoint”判重，一个 endpoint 只应存在一个条目；不同条目可以指向同一个 `hostId`，它们保持为独立别名，除非客户端显式合并。endpoint 变更必须走显式 update，清除 `expectedHostId` 并重新 health 验证。
- **身份协调**：
  - 首次连接：`expectedHostId` 为空，health 成功后固定；
  - 匹配：health 的 `hostId` 与 `expectedHostId` 相同；
  - 不匹配：视为 endpoint 身份被替换，必须报错并要求用户显式更新或移除，绝不自动改写；
  - 移除/重加：移除只删除本地条目，不触碰 Host；重加生成新的 `id`，重新走首次连接；
  - 同一 Host 的多个 endpoint：各自独立条目、独立健康状态，不自动合并。
- **默认与选中**：registry 使用显式版本化文档（`schema: "omo.host-registry"`、`version: 1`），包含 `entries` 和可选 `selectedEntryId`。没有全局单例：`selectedEntryId` 缺失或失效时，由客户端按自身规则解析默认（托管 Web 同源条目、CLI/Electron 首条或本机 daemon），并且不隐式改写其他条目。

### 4.4 连接探测、凭据与每 Host 错误域（M1-002）

M1-002 在 4.3 之上实现共享的每 entry 连接模型；持久化适配器、store 与切换 UI 仍属 M1-003。

- **凭据边界**：Bearer Token 不进入 `HostRegistryEntry`/`HostRegistryDocument`、连接快照、错误消息、日志或任何序列化结果。条目只保存不透明 `credentialRef`。`CredentialResolver.resolve(ref)` 是平台适配器（Electron `safeStorage`、浏览器存储、CLI keychain）；无 `credentialRef` 表示匿名请求，存在 `credentialRef` 但解析失败或返回空值则是显式 `credential-error`。`createInMemoryCredentialResolver` 仅用于测试/fixture，不是生产凭据存储。
- **工厂注入**：`HostConnectionManager` 接收 `createClient(entry, token)` 与 `credentialResolver`。Token 只作为该工厂参数传入，由平台适配器构造 `HttpHostClient`（浏览器用默认 fetch 并拒绝本机 transport，Node 用 Unix socket / named pipe 的 `fetch`）。`@omo/client-core` 不导入 localStorage、Electron、`node:http` 或文件系统。
- **每 entry 状态**：`HostConnectionSnapshot` 以 `entryId` 为键（不是 `hostId` 或 endpoint），状态为 `idle`/`checking`/`online`/`offline`/`unauthorized`/`credential-error`/`identity-mismatch`，只携带安全元数据：归一化 endpoint、`observedHostId`、`latencyMs`、`checkedAt`、`errorCode`/`errorMessage`。没有全局 fatal 状态，一个 Host 的失败不会覆盖另一个 Host。
- **身份协调**：health 成功后必须调用 `reconcileHostIdentity`。首次连接返回 `entryUpdate`（由调用方持久化 `expectedHostId`）；匹配成功且不产生更新；mismatch 是隔离的硬失败，状态为 `identity-mismatch`，绝不改写 registry 条目。Host 进程重启后 `hostId` 不变，仍为匹配。
- **并行探测**：`probeAll` 对每个 entry 独立 settle，`probe` 对可预期失败返回快照而非 reject，因此 A 的 401、B 的不可达和 C 的健康各自产生独立快照。重复别名（同一 endpoint）保留独立 entry、独立 client 与独立状态。
- **错误分类**：`HostRequestError` 暴露 `status` 与按 status 推导的 `code`（`unauthorized`/`forbidden`/`not-found`/`bad-request`/`server-error`/`unknown`），不解析服务端消息文本。连接层把 401/403 映射为 `unauthorized`，网络/未知错误映射为 `offline`，contract 校验失败映射为 `invalid-response`。

### 4.5 Pi adapter

`@omo/pi-runtime` 只包装当前实际使用的 `@earendil-works/pi-coding-agent` stable SDK：

- 创建/打开 Session；
- 列出和维护 Session 文件；
- 获取 model runtime；
- 加载 skill；
- 释放 runtime。

它不得暴露未使用的 Pi experimental capability，也不提前依赖 Chord、`pi-client` 或 SQLite backend。`pi-coding-agent@0.85.0` 的公开入口会加载 experimental server，因此暂时保留精确版本的 `pi-server` 运行时兼容依赖，但 omo 不直接调用它。若上层暂时仍需底层 Pi 对象，将其视为迁移债务并限制在 Server adapter 内，不伪装成稳定公共协议。

## 5. 当前代码组织

现阶段允许业务源码继续位于原目录：

```text
server/       Host HTTP/SSE 与基础设施
cli/          CLI/TUI
src/          Web
packages/
  contracts/
  client-core/    仅 HostClient
  pi-runtime/     仅当前 Pi SDK adapter
```

首个 gate 前不创建 `apps/*` 转发 package、不进行大规模物理搬迁；根脚本直接运行现有目录。垂直切片稳定后，只有在代码真正迁移时才新增对应 workspace app。

`host-core` 中尚未被 Server 使用的 ports、Session coordinator 和 attachment lifecycle 不作为当前架构。Project 等只有单一实现的简单逻辑可以留在 Server；出现第二个调用方或需要独立测试时再抽取。

## 6. 当前协议

### 6.1 查询与命令

沿用 `/api/v1` HTTP API。每个已迁移 endpoint 必须：

- 使用 contracts 校验不可信输入和输出；
- 通过 workspace/session root guard；
- 返回明确 HTTP status 和结构化错误；
- 由 Web 与 CLI 共用同一个 `HostClient` 调用。

### 6.2 实时事件

沿用每个 Session 一条 SSE：

- event 使用单调递增 `sequence`；
- 客户端保存最后成功应用的 sequence；
- 重连发送 `Last-Event-ID` 或 `after`；
- 重复 sequence 被忽略；
- event retention 不足造成缺口时，客户端重新调用 open/sync API；
- Session 生命周期不绑定 SSE 连接。

首个 gate 不引入 revision、delta reducer 或 multiplexing。

### 6.3 Prompt 去重

当前语义是 at-most-once dispatch 的最佳努力实现：

1. 客户端生成 `requestId`；
2. Host 原子写入 acceptance record；
3. 首次写入者 dispatch Prompt；
4. 重复请求返回同一 acceptance result。

Host 在步骤 2 与 3 之间崩溃时可能留下未 dispatch 的 acceptance。完整 operation state machine 与恢复队列只有在真实重启测试要求它时才实现。

## 7. 实施顺序

### Stage S：删除提前抽象

1. 移除 `pi-runtime` 未使用的 experimental 依赖和虚假 capability；
2. 删除未接入的 Host/Client state machine，只保留垂直切片实际使用的接口；
3. 将 P0-006 重新定义为验证性迁移，不宣称 Server 已完全使用 `host-core`；
4. 保持现有行为和测试通过。

### Stage V：完成双客户端垂直切片

1. 为 health、Project、Session list/open、Prompt、abort 和 SSE 建立精确 contracts；
2. 在 `client-core` 实现 HTTP/SSE `HostClient`；
3. CLI 通过 `HostClient` 访问 Host；
4. Web 通过同一个 `HostClient` 访问 Host；
5. 建立两个客户端同时 attach、双向 Prompt、重复请求和 SSE 重连测试；
6. 验证无客户端连接时 Session 继续运行。

### Stage D：本机 daemon

只有 Stage V 通过后才实现：

1. `omo serve` 生命周期与优雅关闭；
2. 本机 daemon discovery、PID 和启动锁；
3. Unix socket / Windows named pipe；
4. CLI 默认发现或启动本机 Host。

### Stage M：多 Host

只有 Web 与 CLI 的单 Host 模型稳定后才实现 Host registry store、多 endpoint 切换、credential reference 和独立错误域。M1-001 落地 4.3 的语义与 `@omo/contracts` schema；M1-002 落地 4.4 的凭据边界、工厂注入、每 entry 连接/探测模型与错误分类。M1-003 已接入：CLI/Web registry store 与持久化、`selectedEntryId` 选中与切换、平台凭据适配器（Electron `safeStorage` / 浏览器 vault）、连接状态订阅与身份固定。重试状态机、endpoint fallback 与聚合缓存仍不在本任务内。

### Stage E：Pi Extension + daemon

Stage E 不把 daemon 塞进 Extension，而是让 Extension 成为原生 Pi runtime 的 bridge，由长期运行的 daemon 继续持有公共 API、认证、事件日志和 headless fallback。实施必须先完成 event/command/launcher 三个 stable API spike，再引入 Session execution lease；完整顺序和 Gate 以 [`extension-daemon-hybrid.md`](extension-daemon-hybrid.md) 与 `task.md` 为准。

## 8. Gate

当前唯一 gate：

```bash
pnpm check
pnpm test
pnpm build
```

并人工/集成验证：

1. 启动 Host；
2. CLI 和 Web 打开同一 Session；
3. CLI Prompt 在 Web 实时出现；
4. Web follow-up 在 CLI 实时出现；
5. Web 断线后从最后 sequence 恢复；
6. 重复 `requestId` 只 dispatch 一次；
7. 两个客户端都断开后 Agent 继续运行。

## 9. Backlog，不是当前计划

以下内容保留为未来选项，不建立 package、不安装依赖、不作为当前任务：

- 单连接 WebSocket channel multiplexing；
- snapshot + revision + ordered delta；
- Pi v2 server/client/protocol、Chord 与 presentation facet；
- durable operation recovery queue；
- Session worker 隔离；
- 多 Host 聚合（M1-001 只定义本地 registry 条目语义，不实现聚合缓存）、device credential 与 RBAC；
- React Native、HarmonyOS 与 push notification；
- Desktop sidecar；
- extension migration framework。

只有当前 gate 暴露出明确需求时，才从 Backlog 提升为有验收标准的任务。
