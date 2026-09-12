# ADR-003：存储布局、幂等受理与掉电 RPO=0

- 状态：已确认（P0 验证中）
- 规划依据：§5.2–§5.8、§8.6、§3.4
- 日期：v2 规划确认时；P0 实测见 [v2-upstream-verification.md](../v2-upstream-verification.md)

## 决策

1. 三类状态三个所有权：执行事实归 core Session Storage；产品事实归 omo 持久存储；派生状态全部可重建。omo 不维护第二份可写 transcript。
2. 执行存储首版复用 `@earendil-works/pi-session-backend-sqlite-node`，每 Session 一个库；共享 Storage Host（§8.6 路线 B）必须先在 `Storage` 边界通过 conformance 才允许替换。
3. 所有 SQLite 写连接：WAL + `synchronous=FULL`（macOS 加 `fullfsync`），打开时设置并读回校验，失败即拒写；不允许静默降级 NORMAL。
4. 命令受理走持久 inbox：去重键 = principal + scope + clientMutationId；同键同 payload 返回原回执，同键不同 payload 拒绝；`202 queued` 回执只在 FULL 同步提交之后发出。
5. 跨库一致性用 durable inbox/outbox + 稳定 ID + 执行侧去重 + 启动对账，不假装两次库写是原子操作；未证明前不宣称「所有命令 exactly-once」。
6. 已确认操作 RPO=0 覆盖受理/完成回执、文件保存、artifact 与插件 generation 发布；磁盘物理损毁与虚报 flush 不在承诺内。

## 已验证（P0）

- 上游 backend 默认**不**设置 `synchronous=FULL`；omo 以可注入 factory 强制并读回（`packages/storage`）。
- 上游 `SqliteSessionRepo` 通过其 SessionRepo conformance（经 durable factory）。
- `CommandInbox`（`packages/control-plane`）实现幂等重放、payload 不匹配拒绝、状态机与崩溃窗口恢复。

## 后果

- 性能调优（group commit、Storage Host）不得以提前确认为代价；`Storage.commit()` resolve 必须晚于所需同步写。
- 三平台（Linux/Windows/macOS）需分别验证目录同步、刷盘与 `fullfsync` 语义；`kill -9` 不算掉电测试。

## 退出/再评估条件

若百会话 FULL 写入路径实测不可行，按 §8.6 在 Storage Host 路线内解决；仍不成立则回到 P0 门槛，不进入主迁移。
