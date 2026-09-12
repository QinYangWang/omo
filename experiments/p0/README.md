# P0 高风险验证实验（omo v2）

对应 [docs/omo-v2-plan.md](../../docs/omo-v2-plan.md) §13 P0 与 §16「立即验证两个闭环」。实验以固定上游版本 `0.85.0` 运行，结论同步记录到 [docs/v2-upstream-verification.md](../../docs/v2-upstream-verification.md)。

## 运行

```bash
npm test        # 全部单元/契约测试（含 packages/*）
npm run test:p0 # 功能/恢复闭环实验（本目录）
```

## 实验清单

| 脚本 | 验证内容 | 对应规划条目 |
| --- | --- | --- |
| `harness-recovery.mjs` | 功能/恢复闭环：固定 operationId 的 accept→drive→completed；Worker 重启后 open operation 恢复并完成；重复 accept 的非幂等行为与 lane 阻塞 | §13 P0 交付 2、3；§3.3.3 |

## 已编码为常驻测试的 P0 断言

| 位置 | 内容 |
| --- | --- |
| `packages/agent-runtime/test/harness.test.ts` | 功能闭环、双 watcher 观察同 lane、恢复闭环、lane busy、settle 后重复 accept 行为钉板 |
| `packages/agent-runtime/test/storage.test.ts` | WAL+FULL pragma 强制与读回、上游 SessionRepo conformance（17 子用例） |
| `packages/control-plane/test/inbox.test.ts` | 命令幂等重放、payload 不匹配拒绝、状态机、崩溃窗口、durable 回执 |
| `packages/protocol/test/protocol.test.ts` | golden wire fixtures、canonical hash、十进制字符串 cursor |

## 待补充（P0 后半）

- Chord reload / drain / 失败宿主重建实验（§13 P0 交付 5）。
- 百会话进程容量与 FULL commit 延迟、存储路线 A/B 比较（§8.6）。
- 独立回执记录器 + 进程/OS 崩溃与受控断电注入（§5.8 验证流程）。
- UI 插件最小样例（§7.10 前置验证）。
