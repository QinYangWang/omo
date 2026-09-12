# ADR-002：复用上游 AgentHarness 的范围、缺口与退出策略

- 状态：已确认（P0 验证中）
- 规划依据：§3.2、§3.3、§12.2
- 日期：v2 规划确认时；P0 实测见 [v2-upstream-verification.md](../v2-upstream-verification.md)

## 决策

1. v2 执行侧基于 `@earendil-works/pi-agent-core` 的 `AgentHarness` / `AgentLane` / `Session` / `Storage`，**不**从 `new Agent()` 重写 loop、分支、压缩、技能与恢复。
2. 固定上游版本（当前 `0.85.0`），声明为直接依赖，不追踪 `latest`；升级前重跑 P0 契约与故障测试。
3. omo 通过 `packages/agent-runtime` 的 `AgentRuntime` 接口隔离上游内部结构；控制面、同步与客户端只依赖 omo 类型。
4. 会话目录与全局运行状态由 omo 投影服务维护，不依赖未实现的 `watchSession()`。

## 已验证（P0）

- 固定 `operationId` 的 `accept()` → `drive()` 分离可用；admission 在 Worker 重启后可恢复并继续完成。
- `lane.watch()` 支持同 lane 多观察者。
- `accept({operationId})` **不是**网络幂等 API：settle 后同 id 会被再次受理并阻塞 lane。omo 在控制面 inbox 去重（见 ADR-003）。

## 后果

- 上行风险集中在上游接口演进；迁移成本由窄适配器吸收。
- 跨库原子性、幂等受理与唯一写者 fencing 不由上游提供，必须自建。

## 退出/再评估条件

若持久受理、唯一写者或安全恢复无法用公开接口承载，需要大量侵入式上游修改时，暂停迁移并评估更窄的自有执行适配器，而不是在新底层上堆兼容补丁。
