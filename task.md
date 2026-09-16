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
- [ ] D1-003：实现 Unix socket 与 Windows named pipe transport
- [ ] D1-004：让 `omo` 默认发现或启动本机 Host 后进入 TUI
- [ ] D1-GATE：验证重复启动、异常退出、重启与本机连接

## Stage M：多 Host

- [ ] M1-001：基于单 Host 使用结果设计 Host registry 与多 endpoint 语义
- [ ] M1-002：实现 credential reference 与每 Host 独立错误域
- [ ] M1-003：实现 Web 与 CLI 多 Host 切换
- [ ] M1-GATE：验证一个 Host 离线不影响其他 Host

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
