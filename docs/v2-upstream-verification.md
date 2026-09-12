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
| `getMemo()/setMemo()` 非原子 | 无 CAS/first-writer-wins 事务 | 持久 Interaction 的答案在 omo 数据库单事务内接受一次（ADR-005） | P3 插件阶段验证 |

## 3. 待后续阶段验证

- Chord 同形 reload / 结构增删 / 自身请求 reload / drain / 失败宿主重建（P0 后半，§13）。
- 百会话进程容量与 FULL commit 延迟、存储路线 A/B（P0 后半 §8.6；P4 完整基准）。
- 三平台（Windows/macOS）刷盘、文件替换与服务生命周期语义；受控断电对账流程。
- `pi-telemetry` adapter 接入与 conformance（P1）。

## 4. 当前 P0 测试基线

```bash
npm test            # v1 既有测试 + packages/* 全部测试
npm run test:v2     # 仅 v2 packages
node --no-warnings experiments/p0/harness-recovery.mjs   # P0 功能/恢复闭环实验
```

基线结果：42 个 v2 测试全部通过（含上游 SessionRepo conformance 17 个子用例）；实验脚本 9 项断言全部成立。
