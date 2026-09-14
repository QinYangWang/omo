# omo v2 掉电持久性验证流程（§5.8）

> 状态：程序性文档。`experiments/p0/durability-receipts.mjs` 已覆盖**进程级**崩溃对账（SIGKILL 不清 OS 页缓存，不代表断电）；本文档定义跨平台**受控断电**验证流程，需在真实硬件上执行后把证据回填到 [v2-upstream-verification.md](v2-upstream-verification.md)。

## 1. 不变量

| 编号 | 不变量 |
| --- | --- |
| R1 | 客户端收到的每一条回执（`queued`/`admitted`/`completed`/文件保存/artifact 发布），断电重启后都能在权威存储中查到，且内容一致——无幻影确认 |
| R2 | 崩溃窗口（已提交未回包）的操作按原 command/mutation ID 对账恢复，不换 ID 重发，不产生重复执行 |
| R3 | 未收到回执的操作允许（且仅允许）处于「未受理」状态；重发同 mutation ID 幂等收敛 |
| R4 | `Storage.commit()` / 文件替换 / artifact 发布在同步写成功前不 resolve、不回包 |

## 2. 存储基线（所有被测进程）

- SQLite：WAL + `synchronous=FULL`；macOS 另加 `fullfsync=1` + `checkpoint_fullfsync=1`（`packages/storage/src/durability.ts` 启动时设置并读回校验，失败拒写）。
- 文件/artifact 发布：写临时文件 → fsync 文件 → 原子 rename → fsync 父目录 → 提交引用记录。
- 网络共享盘（NFS/SMB/ virtiofs 默认配置）不满足可靠同步语义，不作为达标配置；如用户如此部署，启动报告必须标注 `durability=degraded`。

## 3. 分层验证

### 3.1 进程级（已自动化）

`npm run test:p0:all` 中的 `durability-receipts.mjs`：独立回执记录器 + SIGKILL 注入（含「提交后/回复前」窗口）。进程级通过是断电验证的**前提**，不是替代。

### 3.2 OS 重置级（虚拟机）

每台测试机一台 VM，宿主机直接断电重置 VM（不清客户机页缓存的等价物：`virsh destroy` / Hyper-V `Stop-VM -TurnOff` / UTM 强制停止）：

1. VM 内运行 daemon + 驱动客户端；宿主机运行回执记录器（经网络收 VM 客户端转发的回执）。
2. 驱动脚本在受理、文件替换、artifact 发布、结果提交四个边界随机触发 `virsh destroy`。
3. VM 重启 → daemon 恢复 → 对账 R1/R2/R3。
4. **必须核验**宿主机/虚拟机监控器的磁盘缓存配置：QEMU `cache=none` 或 `cache=writeback`+`discard` 行为差异会改变语义；记录 `.xml`/命令行配置作为证据。

### 3.3 真实断电级（物理机）

- Linux：带独立电源切换（PDU/智能插座）的 NVMe 机器；测试中物理断电。
- macOS：Mac mini 断电；验证 `F_FULLFSYNC` 路径（`sqlite3`/`node:sqlite` 的 `PRAGMA fullfsync` 生效）。
- Windows：断电或强制关机；验证 `FlushFileBuffers` 与 `MoveFileEx` 替换语义、ReFS/NTFS 行为差异。
- 每平台至少 200 次边界注入，回执集合零丢失对账。

### 3.4 故障注入点清单

| 边界 | 注入时刻 |
| --- | --- |
| 命令受理 | inbox 事务 COMMIT 后、回执发送前 |
| 执行受理 | Harness `accept()` 提交后、`admitted` 发布前 |
| 工具完成 | 结果写入提交后、`completed` 回执前 |
| 文件保存 | rename 后、父目录 fsync 前/后、receipt 提交前 |
| artifact 发布 | 内容 fsync 后、索引引用提交前 |
| 插件 generation | 产物 fsync 后、desired/active 切换提交前 |

## 4. 证据格式

每次断电运行产出：

```json
{
  "platform": "linux|macos|windows",
  "storageStack": "nvme-ext4|apfs|ntfs",
  "layer": "process|vm-reset|physical",
  "injections": 200,
  "receiptsRecorded": 0,
  "phantomReceipts": 0,
  "duplicates": 0,
  "unreconciled": 0,
  "notes": "host cache config, tool versions"
}
```

结果追加到 `docs/v2-upstream-verification.md` §3，由 P1 Gate 检查。
