# omo v2 上游能力验证清单（P0）

> 固定版本：`@earendil-works/pi-agent-core`、`pi-ai`、`chord`、`pi-telemetry`、`pi-session-backend-sqlite-node` 均为 `0.85.0`，已声明为 omo 直接依赖（不依赖传递安装，不追踪 `latest`）。
>
> 本文档记录 P0 阶段对上游能力的**实测结论**，对应规划 §3.3 的缺口清单。每条结论标注验证方式（测试/实验脚本路径）。上游升级后必须重跑并更新本文档。

## 1. 已验证可用

| 能力 | 结论 | 验证 |
| --- | --- | --- |
| `AgentHarness.create()` + 固定 `operationId` 的 `accept()` / `drive()` 分离 | 可用。受理与推进分离，正是 daemon 需要的形态 | `packages/agent-runtime/test/harness.test.ts` functional loop |
| admission 持久化与恢复 | 已受理未推进的 operation 在 Session 关闭重开后出现在 `open` 清单，`drive({operationId})` 可完成 | 同上 recovery loop；`experiments/p0/harness-recovery.mjs` |
| `lane.getResult(operationId)` | 可按稳定 ID 查询终态（completed/failed/aborted） | 同上 |
| `lane.watch()` 多观察者 | 同一 lane 两个 watcher 均收到 run/message 事件 | `harness.test.ts` two watchers |
| `SqliteSessionRepo` 默认布局 | 每 Session 一个 `${id}.sqlite`，WAL 模式；通过上游 SessionRepo conformance 全套用例 | `packages/agent-runtime/test/storage.test.ts` |
| faux provider | `fauxProvider()` + `createModels()` 可脚本化响应，支撑可控 P0/P4 负载 | `packages/agent-runtime/src/testing.ts` |
| `node:sqlite` 同步写 + WAL + `synchronous=FULL` | 可设置、可读回；`PRAGMA synchronous` 返回 2 | `packages/storage` + `storage.test.ts` pragma 用例 |

## 2. 已确认的缺口与 omo 对策

| 缺口 | 实测行为 | omo 对策 | 验证 |
| --- | --- | --- | --- |
| `accept({operationId})` 非幂等（§3.3.3） | 操作 settle 后用同一 id 再次 `accept` **会被受理**，且未 drive 前阻塞整个 lane（后续 accept 返回 lane busy）；drive 掉该重复操作后 lane 恢复 | omo 控制面 inbox 拥有唯一去重权：同 dedup 键 + 同 payload 返回原回执，不同 payload 拒绝；settled operation id 永不重新 accept | `harness-recovery.mjs` dedup.* 断言；`packages/control-plane/test/inbox.test.ts` |
| 上游 backend 不设置 `synchronous=FULL` | `SqliteSessionRepo` 仅设置 `journal_mode=WAL` 与 `busy_timeout` | omo `createDurableSqliteFactory()`（`packages/storage`）包装注入 factory，强制 WAL+FULL（macOS 加 fullfsync），读回失败即拒写 | `storage.test.ts` pragma 用例 |
| `AgentHarness.watchSession()` | 运行实现抛 `SliceNotImplemented("watchSession")`（§3.3.1） | 会话目录/运行状态由 omo 投影维护；当前不使用该方法 | 规划 §3.3.1（源码核验） |
| `lane.watch()` 快照边界 | 快照围绕 lane 与最近压缩边界构造，不是完整历史分页 | omo 历史查询走独立分页投影；watch 只用于实时尾部 | 规划 §3.3.2（源码核验） |
| `getMemo()/setMemo()` 非原子 | 无 CAS/first-writer-wins 事务 | 持久 Interaction 的答案在 omo 数据库单事务内接受一次（ADR-005） | `packages/control-plane/test/interactions.test.ts`（已实现：单事务抢答 + revision CAS + 重启恢复） |

## 2.1 Chord reload 边界（P0 交付 5，实验 `experiments/p0/chord-reload.mjs`）

| 场景 | 实测结论 | 断言 |
| --- | --- | --- |
| 同形 reload | 稳定句柄在 reload 后分发到新实现；旧 facet `onDeactivate`+`own` 均被调用 | S1.* |
| 失败 reload | 候选 setup 抛错 → reload reject，旧 generation 继续服务 | S2.* |
| 在途调用 | reload **不等待**在途调用即 dispose 旧 facet；旧闭包仍可完成返回。omo 必须自建调用屏障与安全点（§7.5） | S3.* |
| 结构变化 | `reload()` 拒绝未激活的 facet id（"Facet b is not active"）；图变化必须走新 host capsule | S4.* |
| 自请求 reload | 插件经 macrotask 向宿主外 manager 请求 reload，无死锁 | S5.* |
| 泄漏冒烟 | 200 次 reload 后 setup/dispose 计数平衡，堆增长 < 64 MiB | S6.* |
| VM 分代加载 | `bundleFacets` + `createFacetBundleLoader`：内容寻址 CJS、SHA-256 完整性校验默认开启；分代模块状态完全隔离（gen2 计数从 1 重启）。入口必须以 `module.exports.default` 导出 facet | S7.* |

## 2.2 掉电回执对账（实验 `experiments/p0/durability-receipts.mjs`）

240 条命令 + 10 次 SIGKILL（6 次随机 + 4 次注入在「提交后/回复前」窗口）：独立回执记录器（ndjson + fsync）收到 246 条回执，重启对账 240 行持久记录：无幻影回执（R1）、回复窗口崩溃按原身份重放返回原回执（R2）、无重复行（R3）。**限制**：SIGKILL 不清 OS 页缓存，三平台受控断电验证流程仍待执行（§5.8）。

## 2.3 UI 插件最小样例（实验 `experiments/p0/ui-plugin-sample.mjs`）

P0 交付 8 达成：「progress card」插件不经主客户端改动完成端到端闭环——事实经 `NodeAssembler` 折叠为稳定 view model；gen1/gen2 两代 renderer 均产出通过有界组件协议校验的声明式组件树；`ContributionRegistry` 热替换运行旧代 cleanup、无重复贡献；未知 renderer / payload 版本不兼容走只读 fallback；实时追加与全量重放渲染结果逐字节一致；200 次代际切换无泄漏。声明式组件协议（`@omo/plugin-ui-schema`）为 target-neutral，直接覆盖 §6.7 多端映射前提。

## 2.4 多进程容量冒烟（实验 `experiments/p0/capacity-smoke.mjs`，本机 2C/8G）

8 个独立 Session Worker × 15s：2039 次 accept→drive 完成，聚合 ~110 ops/s；单 Worker RSS 150-158 MiB（总计 ~1.2 GiB）；drive p95 13-107ms（由每 op 的 FULL 提交主导——正是 §8.6 要测量的成本）。全部 Worker 持续推进、无崩溃。**外推警示**：按当前单 Worker ~150 MiB 基线，100 Worker 约需 15 GiB，贴着 ADR-006 参考档 16 GiB 预算——P4 需优先做懒加载与内存优化；百会话结论必须在参考机复测。

## 3. 待后续阶段验证

- ~~Chord 同形 reload / 结构增删 / 自身请求 reload / drain / 失败宿主重建~~（已完成，见 §2.1）。
- 三平台（Windows/macOS）刷盘、文件替换与服务生命周期语义；受控断电对账流程（§5.8 → [durability-testing.md](durability-testing.md) 程序已定义，待真实硬件执行）。
- 百会话完整容量与存储路线 A/B 比较：参考机运行（§8.6；P4 完整基准含 Bun 同拓扑对照）。
- `pi-telemetry` adapter 接入与 conformance（P1）。
- RN/RNOH 真机版本交集钉定与风险样机（P2；清单见 [mobile-rn-matrix.md](mobile-rn-matrix.md)）。

## 4. 当前 P0 测试基线

```bash
npm test            # v1 既有测试 + packages/* 全部测试
npm run test:v2     # 仅 v2 packages
npm run test:p0     # 快速实验：harness-recovery + chord-reload + ui-plugin-sample
npm run test:p0:all # 全部实验（含掉电对账与容量冒烟）
```

基线结果：`npm test` 142 个测试全部通过（v2 packages 119 个，含上游 SessionRepo conformance 17 个子用例、Interaction 事务边界 7 用例、插件装配/注册表/schema 17 用例、daemon 组装 55 用例；`test/*.test.mjs` 23 个 = v1 既有 21 个 + Electron 薄壳 2 个）；实验断言 harness-recovery 9/9、chord-reload 15/15、durability-receipts 5/5、capacity-smoke 3/3、ui-plugin-sample 13/13。

> 验收复核（P1 开工前）：已重跑以上全部命令核对；依赖实测 7 个 `@earendil-works/*` 包安装版本与锁文件均为 0.85.0，其中 v2 直接使用的 5 包为精确钉版（`pi-coding-agent`/`pi-server` 属 v1 执行栈与调研依赖，按 §12.2 在 P5 移除）。

## 5. P1 进行中：统一 daemon（packages/daemon）

P1 已完成切片：

1. **控制面骨架 + HTTP 入口**：CommandInbox / InteractionStore / AgentRuntime 组装为模块化 daemon；配对 / 撤销、202 持久回执、命令查询、Interaction、单写者锁、启动对账三崩溃窗口。
2. **Workspace 注册表 + 路径守卫**：roots 内 fail-closed 注册（`--workspace-root` / `OMO_WORKSPACE_ROOTS`，默认 cwd，与 v1 一致）、规范化路径幂等、symlink/TOCTOU 守卫；session catalog 投影；所有命令 scope 校验已注册 workspace。
3. **Artifact 存储 + 文件可靠保存**：内容寻址 artifact（对象先落盘、元数据后提交、读时校验、启动孤儿 GC）；`file.save` 命令带 baseHash CAS + temp/fsync/rename 落盘协议 + 按内容崩溃对账。
4. **历史分页投影**：`Session.findEntries` 经持有 Session 的 Worker 串行读取，decimal-string cursor；绕开未实现的 `watchSession()`（§3.3.1）。
5. **Telemetry**：pi-telemetry 契约的有界 NDJSON sink（轮转、写失败静默），`omo.command.submit/execute` span。
6. **Provider 接线**：`--provider/--model` 走 pi `ModelRuntime` 凭据库（§10.1）。

详见 [daemon.md](daemon.md)。

## 6. P2 进行中：同步协议核心（WSS）

已落地：

- **WSS 多路复用**（`packages/daemon/src/sync.ts`）：一条连接多频道（daemon / workspace / session / terminal），一次性票证认证（§10.1），订阅即快照 + 每订阅严格递增 `publicationSequence` + 溢出 `reset_required`（§6.4、§8.5.10）。
- **事件总线**（`packages/daemon/src/events.ts`）：所有 store 在 FULL 提交后才发射事件；lane 事件经 supervisor watch 转发。
- **草稿**：用户级 CAS 版本化存储 + HTTP + 同步事件（§6.1）。
- **TS 客户端**（`packages/client`）：HTTP `OmoClient` + `OmoSyncClient`（自动重连、一次性票证刷新、客户端序列校验、缺口即重订阅）。
- 两端一致性：两个客户端订阅同一 session 收到完全相同的帧序（§6.6，sync.test.ts 覆盖）。
- **终端 PTY + 输入权**：`terminal.create/kill/control` 持久命令；WS `terminal:<id>` 频道（快照 = 记录 + offset/floor 输出尾）；单设备输入控制、断连免 force 移交、force 接管审计（§6.6）；重启孤儿标记（§8.4 默认不附着）；真实 node-pty e2e 通过（terminal-e2e.test.ts）。

## 7. Electron 薄壳（P1 收尾 / §4.2）

- `electron/daemon.cjs` `DaemonSupervisor`：`ELECTRON_RUN_AS_NODE` 子进程托管 daemon；健康门 + safeStorage 令牌 + 有界崩溃重启 + 退出清理；`test/daemon-supervisor.test.mjs` 用真实 daemon 子进程验证（含 SIGKILL 重启后同 token / 同 serverId）。
- renderer 经 `src/lib/omo-v2.ts` + Settings → Daemon 面板走通标准协议；v1 `pi:*` 执行栈保留，按 §12.2 双轨过渡。
- **v2 会话面起步**：`DaemonSessionsView` 完全走 daemon 协议（目录 / 创建 / 历史分页 / prompt / abort / 草稿 / lane 运行态实时帧）。

## 8. Server 部署（新形态）

- `scripts/restart-omo-daemon.sh`（参考 restart-omo-server.sh）：setsid 脱离、env 驱动、`--faux` 警告、可选 TLS。已实测：启动 → 配对 → pkill 重启后设备保持。
- daemon TLS：`DaemonHttpServer` 接受 cert/key（https + wss 同监听）；`tls.test.ts` 用自签证书验证；域名证书 fullchain.pem + key.pem 实测可用（客户端须按域名访问）。
- **Web 托管**：`--web-root` / `OMO_WEB_ROOT`（v1 同约定）——同一进程服务 dist/ SPA + 协议；`webroot.test.ts` 覆盖静态 / SPA 回退 / 逃逸守卫；实测 SPA + /v1/hello + WSS 票证同端口全通。
- `Dockerfile.daemon` + compose `omo-daemon` 服务（`/data` 卷 + `~/.pi/agent` 凭据挂载）。

## 9. P2 收尾状态

- v2 会话面（`DaemonSessionsView`）：目录 / 创建 / 历史分页（text/thinking/toolCall/toolResult/图片块）/ prompt + 图片附件（artifactIds）/ `session.configure` 改模型与思考级别（§6.6 下一运行边界，串行链保证）/ 草稿 / abort。
- Web 远程接入：无桌面桥时 URL + bootstrap code 配对；令牌为可撤销设备凭据（§10.1）。
- **RN/RNOH 风险样机：仍需指定鸿蒙真机验证（P2 gate 硬性要求，不接受 Android 兼容 APK 代替）**——协议 / 客户端 / 终端通道 / 历史 / 文件保存均已就绪。

P1 剩余（均不阻塞 P2 gate）：三平台服务生命周期（桌面已由 DaemonSupervisor 覆盖）、Session Worker 独立进程化（P4）。
