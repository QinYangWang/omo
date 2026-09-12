# omo v2 架构决策记录（ADR）

本目录记录 v2 已确认的架构决策。每条 ADR 提炼自 [omo-v2-plan.md](../omo-v2-plan.md) 的对应章节；规划文档保留完整论证与验证门槛，ADR 只记录决策、状态与后果。

| ADR | 决策 | 状态 |
| --- | --- | --- |
| [001](001-single-user-controlled-daemon.md) | 单个用户自控 daemon、离线不可查看/操作、唯一写者 | 已确认 |
| [002](002-agent-harness-adoption.md) | 复用上游 `AgentHarness`/`Session`，不直接从 `Agent` 重写 | 已确认（P0 验证中） |
| [003](003-storage-and-durability.md) | 存储布局、跨库 inbox/outbox、掉电 RPO=0 | 已确认（P0 验证中） |
| [004](004-public-protocol.md) | 公开协议、snapshot/delta、cursor、RN/RNOH 适配 | 已确认（协议 v0 已建模） |
| [005](005-trusted-plugins.md) | 可信自生成插件、UI Slots/节点/skill，不做市场/Pi 兼容 | 已确认 |
| [006](006-session-worker-capacity.md) | 100 个独立 Session Worker、lane 子 Agent、预算调度 | 已确认（容量待 P4 验收） |
| [007](007-runtime-node-bun.md) | Node 为首个正确性版本运行时，Bun 以基准决策 | 已确认 |

状态约定：`已确认` = 产品与技术方向不再反复讨论；括注表示仍存在必须通过的工程验证门槛，未通过时按 ADR 中的退出策略重新评估。
