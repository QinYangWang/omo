# P0 高风险验证实验（omo v2）

对应 [docs/omo-v2-plan.md](../../docs/omo-v2-plan.md) §13 P0 与 §16「立即验证两个闭环」。实验以固定上游版本 `0.85.0` 运行，结论同步记录到 [docs/v2-upstream-verification.md](../../docs/v2-upstream-verification.md)。

## 运行

```bash
npm test            # 全部单元/契约测试（含 packages/*）
npm run test:p0     # 快速实验（harness-recovery + chord-reload）
npm run test:p0:all # 全部实验（含掉电对账与多进程容量冒烟，约 1-2 分钟）
```

## 实验清单

| 脚本 | 验证内容 | 对应规划条目 |
| --- | --- | --- |
| `harness-recovery.mjs` | 功能/恢复闭环：固定 operationId 的 accept→drive→completed；Worker 重启后 open operation 恢复并完成；重复 accept 的非幂等行为与 lane 阻塞 | §13 P0 交付 2、3；§3.3.3 |
| `chord-reload.mjs` | Chord reload 七场景：同形热替换/失败保留旧版/不 drain 在途调用/结构变化需新宿主/自请求 reload 无死锁/200 次 reload 无泄漏/VM 分代隔离 | §13 P0 交付 5；§3.3.6-8；§7.4 |
| `durability-receipts.mjs` | 独立回执记录器 + SIGKILL 注入：无幻影回执、回复窗口崩溃可按原身份对账、无重复行 | §5.4/§5.8；§13 P0 交付 7；§14 受理 |
| `capacity-smoke.mjs` | W 个独立 Session Worker 进程并发推进，聚合吞吐/RSS/p95 延迟；默认 8×15s 冒烟，百会话用同脚本在参考机运行 | §8.1；§13 P0 交付 6 |
| `ui-plugin-sample.mjs` | UI 插件最小样例：稳定节点装配 + keyed renderer + 代际热替换（不改宿主）+ fallback + 回放一致 + 200 次切换无泄漏 | §13 P0 交付 8；§7.0/§7.10 |

## 已编码为常驻测试的 P0 断言

| 位置 | 内容 |
| --- | --- |
| `packages/agent-runtime/test/harness.test.ts` | 功能闭环、双 watcher 观察同 lane、恢复闭环、lane busy、settle 后重复 accept 行为钉板 |
| `packages/agent-runtime/test/storage.test.ts` | WAL+FULL pragma 强制与读回、上游 SessionRepo conformance（17 子用例） |
| `packages/control-plane/test/inbox.test.ts` | 命令幂等重放、payload 不匹配拒绝、状态机、崩溃窗口、durable 回执 |
| `packages/protocol/test/protocol.test.ts` | golden wire fixtures、canonical hash、十进制字符串 cursor |

## 待补充（P0 收尾）

- 三平台受控断电实测（程序见 [docs/durability-testing.md](../../docs/durability-testing.md)）。
- 百会话完整容量：参考机（16C/32G/NVMe）运行 `capacity-smoke.mjs 100`，比较存储路线 A/B（§8.6）。
- RN/RNOH 真机版本交集与风险样机（清单见 [docs/mobile-rn-matrix.md](../../docs/mobile-rn-matrix.md)，P2 执行）。
