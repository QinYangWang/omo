# Pi Extension + omo daemon 混合架构

> 状态：目标设计与实施任务基线。当前生产路径仍是 `docs/architecture-v2.md` 描述的 Host-owned runtime；只有各阶段 Gate 通过后，才逐步切换默认行为。
>
> 安装、升级、版本兼容与运维排查见 [pi-extension.md](pi-extension.md)。

## 1. 目标

本阶段解决当前两套 TUI/runtime 之间的结构性问题：

- 本机用户使用 Pi 原生 TUI，而不是 omo 维护一份简化 TUI；
- 原生 TUI 中的 Prompt、streaming、tool、retry、compaction 与 Session 切换事件可以实时到达 Web/Desktop；
- Web 发出的 Prompt/Abort 可以进入同一个原生 Pi `AgentSession`；
- Pi TUI 退出后 omo daemon 仍存活，Web、认证、事件日志、终端与多 Host 不依附于 TUI 生命周期；
- 同一 Session 在任意时刻只有一个执行所有者，禁止原生 Pi 与 daemon 同时写同一 Session。

这不是把公网 Server 放进 Extension。Extension 是当前 Pi 进程的原生 bridge；daemon 仍是长期运行的管理面与网络边界。

## 2. 目标拓扑

```text
Pi native TUI
  └─ omo Pi Extension
       ├─ native Pi lifecycle/events
       └─ private local HTTP + SSE
                    │
                    ▼
              omo daemon
       ├─ Session execution broker
       ├─ headless AgentSession
       ├─ SQLite event log / replay
       ├─ auth / TLS / workspace guards
       ├─ terminal / files / git / browser
       └─ public HTTP + SSE + terminal WebSocket
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
         Web               Desktop
```

`omo` 的本机默认入口最终变为：发现或启动 daemon，然后启动项目内置的 Pi 原生 TUI并显式加载 omo Extension。用户仍不需要全局安装 Pi。

远程 `omo --server <id>` 暂时保留现有 omo TUI/HostClient 路径；Pi 原生 TUI不能被假设为任意远程 Host 的透明前端。

## 3. 边界与所有权

### 3.1 Extension

Extension 只负责当前 Pi 进程：

- 在 `session_start` 后向本机 daemon 注册当前 Session；
- 转发 `message_*`、`turn_*`、`tool_execution_*`、`agent_*`、retry、compaction、model 与 Session lifecycle 事件；
- 从 daemon 的私有命令流接收 Prompt 和 Abort；
- 使用 Pi 原生 `sendUserMessage()` / abort 能力执行命令；
- 在 `session_shutdown` 时停止 Session 级资源并注销 attachment；
- 不在 Extension factory 中启动 watcher、timer、socket 或子进程；
- 不开放公网 HTTP/WebSocket，不拥有 TLS、CORS、用户 Token 或 workspace API。

### 3.2 daemon

daemon 继续负责：

- Project、Host registry、凭据边界与路径 guard；
- 公共 HTTP/SSE API 和现有 Terminal WebSocket；
- 事件 sequence、SQLite replay 与 Prompt acceptance；
- headless `AgentSession`；
- native attachment registry 和执行租约；
- Pi TUI 退出后的状态收敛与后续 Session 恢复策略。

### 3.3 Client

Web/Desktop 继续只使用 `HostClient` 和现有公共协议。客户端不直接连接 Extension，也不判断 Prompt 应由 native 或 headless runtime 执行；daemon broker 对外保持一个 Session endpoint。

## 4. Session 执行所有权

每个 Host Session 只能处于以下一种稳定状态：

```text
headless-owned   daemon 内 AgentSession 是唯一执行者
native-attached  一个经过认证的 Extension instance 是唯一执行者
detached         没有活跃执行者，可读历史但不能假装仍在运行
```

允许短暂的 `attaching` / `detaching` 内部状态，但不能作为公共稳定状态。

租约键至少包含：

- durable Host `hostId`；
- Pi Session id 与 canonical Session file；
- Extension `instanceId`（每个进程启动重新生成）；
- attachment generation；
- attached timestamp 与 last heartbeat。

核心规则：

1. daemon 必须先取得 Session lease，之后才能创建 headless runtime 或确认 native attachment；
2. headless runtime 正在 streaming 时拒绝 native attach，不进行隐式抢占；
3. native attachment 活跃时，daemon 不得为该 Session 创建第二个 `AgentSession`；
4. Extension 失联且当时处于运行中时，将 operation 标记为 interrupted/unknown，不自动重复 dispatch；
5. 只有旧 generation 明确释放或超时失效后，新 generation 才能接管；
6. endpoint 重连必须携带 instance/generation，旧连接的迟到事件和 ack 必须被拒绝；
7. Session 文件是持久历史，不是执行锁，也不能作为实时事件总线。

第一阶段不实现 native ↔ headless 的无缝运行中迁移。只允许 idle 边界上的显式交接。

## 5. 私有 Extension 通道

首版不新增统一 WebSocket。Extension 通过 daemon 已有本机 Unix socket / Windows named pipe 使用私有 HTTP + SSE：

- `register`：注册 instance、Session 和 capability；
- `heartbeat`：延长 attachment lease；
- `events`：批量提交原生 Pi event；
- `commands`：SSE 接收 daemon 命令；
- `ack`：确认 accepted / started / rejected / completed；
- `detach`：正常释放 attachment。

通道只监听本机 endpoint，并使用 daemon 发放的短期 instance credential。公共 Bearer Token 不写入 Extension 配置或 Session JSONL。

请求与事件必须包含 generation 和单调序号。daemon 对 `(instanceId, generation, nativeSequence)` 去重，再映射到现有 Host event `sequence`。Web 继续只观察 Host sequence。

## 6. Prompt 与事件流

### 6.1 native → clients

```text
Pi event
→ Extension handler
→ private event batch
→ daemon validates lease/generation
→ SQLite event append + Host sequence
→ existing SSE
→ Web/Desktop/omo remote TUI
```

实时事件不再依赖 JSONL `fs.watch`。Session JSONL 只用于历史恢复和最终校准。

### 6.2 clients → native

```text
HostClient.prompt(requestId)
→ durable acceptance
→ execution broker sees native-attached
→ private command stream
→ Extension sendUserMessage()
→ command ack
→ native Pi events
→ Host SSE
```

现有 acceptance 与 dispatch 崩溃窗口仍然存在，除非后续单独实现 durable operation recovery。本阶段不得宣称 exactly-once。

### 6.3 Abort

Abort 只发送给当前 lease owner。generation 变化后，旧 Abort 不得影响新 owner。Extension 必须返回结构化 ack；连接中断只报告 unknown，不伪造成功。

## 7. Session lifecycle

- `/new`、`/resume`、`/fork`：旧 Extension instance 的 Session 资源在 `session_shutdown` 清理；新绑定完成后由新的 `session_start` 注册。
- `/reload`：视为 attachment generation 变化；旧 handler 返回后不得复用旧 SessionContext。
- 正常退出：detach 后 daemon 将 Session 置为 detached。
- 异常退出：heartbeat 超时后失效；若没有活动 operation，Session 可在下一条 Prompt 前显式恢复为 headless-owned；若存在活动 operation，先暴露 interrupted 状态。
- daemon 重启：Extension 重新注册并获得新 generation；Extension 不自行重放无法证明是否已接受的 command。

## 8. 兼容与迁移

- 当前 `fs.watch` + `omo_session_file` 暂时保留，支持没有安装 Extension 的外部 Pi；
- 同一 Session 存在有效 native attachment 时，daemon 必须抑制文件 watcher 产生的重复实时消息，只允许其作为持久化校准信号；
- 当前简化 omo TUI 保留为远程 Host 与回退路径，在 native Gate 完成前不删除；
- 不建立通用“extension migration framework”；这里只实现一个版本锁定的 omo Pi package；
- `@omo/pi-runtime` 继续服务 headless runtime；Extension 只使用 Pi stable Extension API；
- Pi SDK 与 Extension peer version 必须锁定并在升级时跑兼容 Gate。

## 9. 非目标

本阶段不实现：

- 把公网 HTTP/WebSocket Server 放进 Extension；
- 统一所有公共通道为一个 WebSocket；
- 运行中的 native/headless 热迁移；
- 多个 native Pi 进程共同执行同一 Session；
- durable operation recovery queue；
- Pi experimental v2 server/client/protocol；
- 移动端、RBAC、Session worker 或通用插件迁移框架。

## 10. 最终验收矩阵

1. 原生 Pi TUI Prompt 在 Web 中 token 级实时出现；
2. Web Prompt 出现在原生 Pi TUI并由同一个 AgentSession 执行；
3. Web Abort 只终止当前 native owner；
4. Pi `/new`、`/resume`、`/fork` 后 attachment 指向正确 Session；
5. native attachment 活跃时不存在第二个 headless runtime；
6. 两个 native 进程竞争同一 Session 时只有一个取得 lease；
7. Pi TUI 正常退出后 daemon 与 Web 继续运行；
8. Pi TUI 在 turn 中崩溃时 operation 标记 interrupted，不自动重复 Prompt；
9. Extension 重连、daemon 重启和 SSE 重连不产生重复 event；
10. 无 Extension 时，现有 headless 与文件同步兼容路径无回归；
11. `omo` 使用项目依赖中的 Pi，不要求全局安装；
12. `pnpm check`、`pnpm test`、`pnpm build` 与真实双终端 + 浏览器 E2E 全部通过。
