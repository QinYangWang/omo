# ADR-007：首个正确性版本用 Node，Bun 以同拓扑基准决策

- 状态：已确认
- 规划依据：§9、§11、§13 P4
- 日期：v2 规划确认时

## 决策

1. v2 首个正确性版本使用固定版本的 Node；保留 Bun 运行通路，以数据决定是否成为默认。
2. 运行时相关模块（HTTP、Socket、SessionStorageFactory、ProcessSupervisor、PTY、FileWatcher、PluginLoader）走窄适配器隔离；core 产品模块不直接依赖 `Bun.*`。
3. 基准必须同拓扑：100 个对应运行时的 Session Worker、相同 faux 脚本、相同存储布局与 FULL 同步设置、计入整棵进程树（含 PTY/插件 helper）。
4. Bun 切换门槛：全部正确性/安全/恢复测试通过；代表性负载吞吐或 CPU/内存效率持续可复现收益（参考 ≥20%）且关键 p95 无退化；冷启动收益不得以热重载泄漏、取消失败或更弱持久性为代价。
5. 若仅 Linux server 获益，允许 server 用 Bun、桌面 daemon 继续 Node。

## 理由

- Agent 工作同时受模型延迟、限流、工具进程与 I/O 制约；hello-world 更快不代表 Agent 任务更快。
- Electron 主进程无法替换为 Bun；可替换的只是独立 daemon/Runtime Host。
- 为 Bun 额外保留 Node PTY/插件 helper 的成本必须计入完整进程树。

## 后果

- 9.3 兼容矩阵（Provider、Harness、Chord、SQLite、进程/PTY、文件系统、打包）逐项验证后才允许切换。
- 基准报告作为本 ADR 的附件数据，在 P4 归档。

## 退出/再评估条件

若 Bun 在同等持久性与进程拓扑下无显著端到端收益，保持 Node 默认，Bun 通路仅作兼容保留。
