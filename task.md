# Tasks

## 已完成基线

- [x] BASE-001：定义 pnpm、Host-only execution 与多端同步方向（`15fed1d`）
- [x] SPIKE-001：验证 Host identity、omo TUI、CLI/Web Session event mirror（`dca5577`）
- [x] P0-001：建立 pnpm workspace 与应用命令入口（`92221df`）
- [x] P0-002：建立当前 Host DTO 的运行时 contracts（`7f5047e`）
- [x] P0-003-SPIKE：验证 Pi SDK adapter 与版本锁定（`e670f13`）
- [x] P0-004-SPIKE：验证 Project、operation 与 Session ports（`9a52166`）
- [x] P0-005-SPIKE：验证 Host registry 与 attachment state 模型（`bd77cf6`）
- [x] P0-006-SPIKE：验证 Server 可经 adapter 调用 Project、operation 与 Pi SDK（`c1d292d`）
- [x] RESET-001：将 v2 收缩为 CLI TUI ↔ Host ↔ Web HTTP/SSE 垂直切片

## Stage S：删除提前抽象

- [x] S0-001：移除 `pi-runtime` 未使用的 experimental 依赖、capability 声明与公开类型泄漏
- [x] S0-002：删除未接入的 `host-core` Session coordinator、attachment lifecycle 与冗余 ports
- [x] S0-003：将 `client-core` 收缩为最小 `HostClient` 接口，暂不抽取 Host registry 和连接状态机
- [x] S0-004：清理 workspace 转发依赖，确保旧目录在垂直切片完成前可直接开发运行
- [x] S0-GATE：通过 `pnpm check`、`pnpm test`、`pnpm build`，且行为无回归

## Stage V：双客户端垂直切片

- [x] V1-001：补齐 health、Project、Session list/open、Prompt、abort 与 SSE 的 contracts
- [x] V1-002：实现基于现有 `/api/v1` HTTP/SSE 的共享 `HostClient`
- [x] V1-003：让 CLI 只通过 `HostClient` 访问 Host
- [x] V1-004：让 Web 垂直切片的 Project、Session 与 Agent HTTP/SSE 只通过 `HostClient` 访问 Host
- [x] V1-005：建立 CLI 与 Web 同时 attach 同一 Session 的集成测试
- [x] V1-006：验证 CLI Prompt → Web 实时显示
- [x] V1-007：验证 Web follow-up → CLI 实时显示
- [x] V1-008：验证 SSE 重复事件、断线与 sequence 重放
- [x] V1-009：验证重复 `requestId` 只 dispatch 一次，并记录崩溃窗口限制
- [x] V1-010：验证无客户端连接时 Session 继续运行
- [x] V1-GATE：完成 CLI TUI ↔ Host ↔ Web 首个可验收切片

## Stage D：本机 daemon

- [x] D1-001：实现 `omo serve` 生命周期与优雅关闭
- [x] D1-002：实现 daemon discovery、PID、启动锁与 stale PID 清理
- [x] D1-003：实现 Unix socket 与 Windows named pipe transport
- [x] D1-004：让 `omo` 默认发现或启动本机 Host 后进入 TUI
- [x] D1-GATE：验证重复启动、异常退出、重启与本机连接

## Performance：CLI 启动

- [x] PERF-001：将 workspace 编译移至安装/开发阶段，正常 `omo` 启动不再重复执行 TypeScript build
- [x] PERF-GATE：已运行 daemon 的 `pnpm run omo -- session list` 启动时间低于 1 秒

## Stage M：多 Host

- [x] M1-001：基于单 Host 使用结果设计 Host registry 与多 endpoint 语义
- [x] M1-002：实现 credential reference 与每 Host 独立错误域
- [x] M1-003：实现 Web 与 CLI 多 Host 切换
- [x] M1-GATE：验证一个 Host 离线不影响其他 Host

## Stage E：Pi Extension + daemon 混合架构

详细设计与所有权规则见 `docs/extension-daemon-hybrid.md`。每个任务单独提交；只有前一 Gate 通过后才进入下一阶段。

### E0：可行性与稳定 API Spike

- [x] E0-001：定义 Extension/daemon 边界、Session 执行所有权、私有通道与分阶段任务
- [x] E0-002：Spike：Extension 从原生 Pi TUI 转发 message/turn/tool/agent 事件到测试接收端（`3602ebf`）
- [ ] E0-003：Spike：通过 Extension command bridge 将外部 Prompt 与 Abort 注入同一个原生 AgentSession
- [x] E0-004：Spike：`omo` 使用项目锁定的 Pi 依赖启动原生 TUI并显式加载 Extension，无需全局安装 Pi（`9909fd3`）
- [ ] E0-GATE：真实 Pi TUI Prompt 可在测试客户端 token 级显示，外部 Prompt 可由同一 runtime 执行，退出后无残留资源

### E1：Attachment contract 与执行租约

- [ ] E1-001：为 register、heartbeat、detach、native event batch、command stream 与 ack 定义运行时 contracts
- [ ] E1-002：实现仅限本机 socket/pipe 的 Extension 私有 HTTP/SSE 通道与短期 instance credential
- [ ] E1-003：实现 `headless-owned` / `native-attached` / `detached` SessionExecutionBroker 与 generation lease
- [ ] E1-004：将 native sequence 去重后映射为现有 Host event sequence，并抑制 attachment 活跃时的文件 watcher 重复事件
- [ ] E1-GATE：验证 attach 竞争、stale generation、heartbeat 超时、daemon 重启与单 Session 单执行者

### E2：omo Pi Extension package

- [ ] E2-001：建立版本锁定的 omo Pi package；只在 `session_start` 启动资源并在 `session_shutdown` 幂等清理
- [ ] E2-002：实现 Session 注册、heartbeat 及 message/turn/tool/agent/retry/compaction/model lifecycle 转发
- [ ] E2-003：实现私有 command stream 的 Prompt/Abort dispatch、结构化 ack 与 requestId 关联
- [ ] E2-004：正确处理 `/new`、`/resume`、`/fork`、`/reload` 和异常退出，不复用 stale SessionContext
- [ ] E2-GATE：验证 Extension reload/switch/crash 不泄漏 watcher、timer、socket 或旧 generation 事件

### E3：原生本机 CLI

- [ ] E3-001：让本机 `omo` 发现/启动 daemon 后进入带 omo Extension 的 Pi 原生 TUI
- [ ] E3-002：保留现有 omo TUI 作为远程 `--server` 与显式 fallback，定义清晰的选择优先级
- [ ] E3-003：实现原生 TUI 启动失败、daemon 不可达与版本不兼容的可操作错误和安全回退
- [ ] E3-GATE：验证本机无需全局 Pi、原生 TUI 功能无降级、远程 Host 路径无回归

### E4：Web/Desktop 双向控制

- [ ] E4-001：在现有 Session API 中暴露安全的 execution owner/attachment 状态，不泄漏 process credential
- [ ] E4-002：通过 broker 将 Web Prompt/Abort 路由到 native owner，禁止 selected native 失败时隐式创建 headless runtime
- [ ] E4-003：验证 native event 的 SQLite replay、客户端 SSE 重连与 Extension 重连去重
- [ ] E4-004：保留无 Extension 外部 Pi 的 JSONL 校准路径，并验证不会与 native event 双重渲染
- [ ] E4-GATE：完成 Pi native TUI ↔ daemon ↔ Web/Desktop 双向实时 E2E，一个客户端断线不影响执行

### E5：故障恢复与默认切换

- [ ] E5-001：实现 idle 边界上的显式 native detach → headless resume；运行中崩溃只标记 interrupted，不自动重复 dispatch
- [ ] E5-002：在所有 Gate 通过后将本机 `omo` 默认切换为 Pi 原生 TUI，保留一个发布周期的 legacy fallback
- [ ] E5-003：完成 Pi package 安装/升级、版本兼容、运维与故障排查文档
- [ ] E5-GATE：通过单执行者竞争、Pi/daemon 异常退出、重启重连、事件去重和真实浏览器验收矩阵

## Backlog：不进入当前实施

- [ ] BACKLOG-001：统一 WebSocket channel multiplexing
- [ ] BACKLOG-002：snapshot、revision 与 ordered delta
- [ ] BACKLOG-003：Pi v2 server/client/protocol、Chord 与 presentation facet
- [ ] BACKLOG-004：durable operation recovery queue
- [ ] BACKLOG-005：Session worker 隔离
- [ ] BACKLOG-006：device credential、RBAC 与审计
- [ ] BACKLOG-007：React Native、HarmonyOS 与 push notification
- [ ] BACKLOG-008：Desktop Host sidecar
- [ ] BACKLOG-009：extension migration framework
