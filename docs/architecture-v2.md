# omo v2：精简执行架构

> 状态：执行基线。本文只描述当前垂直切片需要的架构；远期设想统一放入末尾 Backlog，不作为当前实现前置条件。

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
- 多 Host 聚合视图；
- 一个 Host 的多个 endpoint 自动合并；
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

Host registry 暂时沿用 Web 现有实现；等 CLI 与 Web 都出现同样需求后再抽取。一个 Host 多 endpoint、设备凭据和聚合缓存全部延后。

### 4.3 Pi adapter

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

只有 Web 与 CLI 的单 Host 模型稳定后才实现 Host registry、多个 endpoint、credential reference 和独立错误域。

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
- 多 Host 聚合、device credential 与 RBAC；
- React Native、HarmonyOS 与 push notification；
- Desktop sidecar；
- extension migration framework。

只有当前 gate 暴露出明确需求时，才从 Backlog 提升为有验收标准的任务。
