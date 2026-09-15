# Tasks

## Baseline

- [x] BASE-001：定义 pnpm、多 Host、Host-only execution 与多端同步架构（`15fed1d`）
- [x] SPIKE-001：验证 Host identity、omo TUI、CLI/Web Session event mirror（`dca5577`）

## Phase 0：边界与兼容基线

- [x] P0-001：建立 pnpm monorepo 的 `apps/*`、`packages/*` workspace 与根级编排脚本
- [ ] P0-002：建立 `@omo/contracts`，定义并校验 Host、Project、Session、Agent command/event DTO
- [ ] P0-003：建立 `@omo/pi-runtime`，封装当前 `pi-coding-agent` SDK 与实验性 v2 能力
- [ ] P0-004：建立 `@omo/host-core`，抽离 Project、Session、operation、workspace 用例及 ports
- [ ] P0-005：建立 `@omo/client-core`，抽离 Host registry、Host identity、connection 与 Session attachment 状态
- [ ] P0-006：让现有 Server 只通过 `host-core` 与 `pi-runtime` 执行业务
- [ ] P0-007：让 Web 与 CLI 只通过 `client-core` 访问 Host
- [ ] P0-008：为 HTTP/SSE 兼容 API 建立 contracts、幂等、重放与双客户端测试
- [ ] P0-009：建立 Linux、macOS、Windows 的 Node 22、`node-pty`、SQLite 与 Pi SDK CI smoke tests
- [ ] P0-GATE：通过 `pnpm check`、`pnpm test`、`pnpm build` 与全部 contract/native smoke tests

## Phase 1：Host、CLI TUI 与 Web

- [ ] P1-001：实现 `omo serve`、本机 daemon discovery、启动锁、PID 与优雅关闭
- [ ] P1-002：实现 omo TUI 的 Host、Project、Session 选择与远程连接状态
- [ ] P1-003：实现一个 Session 一个权威 runtime、多 presentation attachment
- [ ] P1-004：实现 CLI Prompt → Web 实时显示
- [ ] P1-005：实现 Web follow-up → CLI TUI 实时显示
- [ ] P1-006：实现手机浏览器切后台、断线、重连与 snapshot 恢复
- [ ] P1-007：实现 Prompt、abort、branch、rename 的统一 `operationId` 幂等
- [ ] P1-008：验证 Host 无客户端连接时 Session 继续运行
- [ ] P1-GATE：完成 CLI TUI ↔ Host ↔ Web 首个垂直切片验收

## Phase 2：统一实时协议

- [ ] P2-001：实现 capability handshake、持久化 `hostId` 与协议版本协商
- [ ] P2-002：实现一次性 WebSocket ticket 与认证连接上下文
- [ ] P2-003：实现单连接 channel multiplexing
- [ ] P2-004：实现 Session snapshot、revision 与 ordered delta
- [ ] P2-005：实现 revision gap 检测与强制 rehydrate
- [ ] P2-006：接入 Pi v2 client/server、Chord service 与 Transcript adapter
- [ ] P2-007：保留 `/api/v1` 兼容层并提供迁移测试
- [ ] P2-GATE：通过断网、重复命令、并发客户端、Host 重启与协议降级测试

## Phase 3：多 Host 与多端产品化

- [ ] P3-001：实现 Web 多 Host registry、聚合视图与独立错误域
- [ ] P3-002：实现 device credential、撤销与基础 RBAC
- [ ] P3-003：实现 React Native iOS/Android client
- [ ] P3-004：实现 HarmonyOS client adapter
- [ ] P3-005：实现 push notification、深链与移动端后台恢复
- [ ] P3-006：Desktop 恢复可用后实现 Host sidecar 与 keychain adapter
- [ ] P3-GATE：完成 Web、iOS、Android、HarmonyOS 的多 Host 同步验收

## Phase 4：Extension migration

- [ ] P4-001：建立 `@omo/extension-migration` package 与 migration skill
- [ ] P4-002：实现 Pi extension 静态扫描与兼容性分级
- [ ] P4-003：实现 worker/session facet 与 presentation facet 拆分迁移
- [ ] P4-004：生成 TypeBox contract、Chord service 与 replicated state
- [ ] P4-005：实现 `omo migrate extension`、`--dry-run` 与 report
- [ ] P4-006：建立原 Pi TUI 与 omo TUI 行为对照测试
- [ ] P4-GATE：通过 tool、hook、command、TUI 与混合 extension 迁移样例
