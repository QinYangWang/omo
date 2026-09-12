# ADR-006：100 个独立 Session Worker、子 Agent lane 与预算调度

- 状态：已确认（容量数字待 P4 验收校准）
- 规划依据：§8.1–§8.5、§11
- 日期：v2 规划确认时

## 决策

1. 容量口径是 **100 个独立 OS 进程**，每个拥有不同根 Session 且至少一个正在推进的 operation，跨多项目分布；排队任务数、空闲 PID、连接数、Promise 数都不能替代。
2. Supervisor 公布 `residentSessionWorkers`/`runningSessions`/`queuedSessions`/`waitingForProvider`/`waitingForInteraction`/`activeModelRequests`/`activeToolProcesses`，指标不可互相替代。
3. 同 Session 的可信子 Agent 用 lane 复用 Worker 内资源；独立身份/权限/保留策略的子任务才创建独立 Session；禁止递归「一子 Agent 一进程」。
4. 分层限流：用户/workspace 队列、活跃 Session 数、Provider RPM/TPM 与费用、工具/PTY/CPU 额度、Plugin Host 数、输出字节与订阅缓冲；公平队列保证交互/审批/取消不被后台 fan-out 饥饿。
5. 父任务等待子任务时释放可运行槽位，避免调度死锁；设置最大深度/扇出/任务数/token/时限与取消传播。
6. 参考档 16 逻辑 CPU / 32 GiB / 本地 NVMe 仅为基准参考，不是最低配置承诺；内存按完整进程树（含 helper/工具/PTY）计。

## 后果

- 达到 100 活跃会话后的新命令排队或拒绝；不得通过把 100 个会话排成 10 个执行来「达标」。
- 控制面鉴权/取消/心跳不得被磁盘同步阻塞；同步存储操作放受控 worker。
- 24h 混合长稳 + 故障注入是验收组成，不是可选优化。

## 退出/再评估条件

P0/P4 实测若证明 FULL 提交下百进程存储放大不可行，按 §8.6 换 Storage Host 路线；两路线都不达标则不进入主迁移，且不把指标改成排队任务。
