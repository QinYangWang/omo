# 基准（benchmarks）

> 这是**实测基线**，不是产品承诺。每次记录必须带机器、日期和 commit，
> 否则数字没有意义。回归 = 数字变了，而不是数字超过了某个目标。

## 测量方法

| 指标 | 怎么测 | 脚本 |
|---|---|---|
| 启动 | app 自报：`OMO_BENCH_STARTUP=1` 时，视图第一次构建完成（首个可用帧）减去 `main()` 开始；打印 `bench first_frame_ms=`，9 次取中位 | `scripts/bench/bench.ps1`、`scripts/bench/bench.sh` |
| 空闲 CPU | 启动后等 3 s 让窗口 settled，然后读取进程 CPU 时间，等 60 s 再读一次，取差值 | 同上 |
| 内存 | 同一次采样里的 working set / private bytes（Windows）或 RSS（Unix） | 同上 |

为什么「首帧」而不是「窗口出现」：用户能用的那一刻是界面画出来的时候。
`Window.Invalidate` 与事件驱动渲染意味着窗口生成了但没有内容不算可用。

```powershell
go build -o build/omo.exe .
pwsh -File scripts/bench/bench.ps1 -Samples 9 -IdleSeconds 60
```

```sh
CGO_ENABLED=0 go build -o build/omo .
SAMPLES=9 IDLE_SECONDS=60 ./scripts/bench/bench.sh
```

## 2026-10-29 · Windows 11 · amd64 · P1

- 机器：本机开发机（Windows 11，amd64；渲染路径由 MyGo 选择 D3D11）
- 构建：`CGO_ENABLED=0 go build -trimpath -o build/omo.exe .`
- 代码状态：**P1** —— 真实文件树、编辑器读写、外部修改冲突、git 改动列表 + Diff 审查、原生终端
- 窗口状态：无工作区、未开终端、面板关闭（空状态基线）

### 启动（到首帧）

| 指标 | 值 |
|---|---|
| 中位 | **38.9 ms** |
| 最小 / 最大 | 36.8 ms / 57.3 ms |
| 样本数 | 7 |

样本：57.3, 38.9, 37.7, 37.8, 45.3, 42.1, 36.8 ms。
比 P0（84.4 ms）快一半，原因是首帧不再渲染演示文件树与编辑器，
只有空状态、侧栏与状态栏；这不是「优化」，只是首帧内容变少。

### 空闲（时间序列，87 s）

| 时刻 | CPU 累计 | working set | private | handles |
|---|---|---|---|---|
| 3 s（settled） | 0.250 s | 69.9 MB | 108.4 MB | 381 |
| 15 s | 0.281 s | 116.4 MB | 108.4 MB | 383 |
| 27 s | 0.281 s | 116.4 MB | 108.4 MB | 383 |
| 39 s | 0.281 s | 116.4 MB | 108.4 MB | 384 |
| 51 s | 0.281 s | 116.4 MB | 108.4 MB | 384 |
| 63 s | 0.281 s | 116.3 MB | 108.3 MB | 382 |
| 75 s | 0.281 s | 116.3 MB | 108.3 MB | 382 |
| 87 s | 0.281 s | 116.3 MB | 108.3 MB | 382 |

结论（全部从这张表读出，不靠猜）：

1. **启动后 12 s 内有一次 0.031 s 的 CPU 与 +46 MB working set 的一次性增长**，
   之后 72 s 内 CPU **增量 0.000 s**、working set 与 private **完全平**。
   这是一次性分配（字体图集 / D3D11 资源在首次完整重绘时落地），**不是泄漏**：
   private 没有增长，handles 稳定在 381–384。
2. 稳定态基线：**116.3 MB working set / 108.3 MB private / 每分钟 0.000 s CPU**。
3. private 高于 working set 是 Windows 上的常态（Go 堆 + GPU 驱动的已提交内存），
   与 macOS/AppKit 的数字不可直接比较。

测量纪律（沿用 P0 结论，这次又验证了一遍）：

- 一次构建之后**放弃第一次运行**；本次数据在构建后等待 15 s 才采集。
- 报中位数并给出样本区间；空闲测量至少 45 s，且从 settled（首帧后 3 s）开始。
- `bench.ps1` 只采两个点，若要判断「是否泄漏」必须用上面的时间序列采样，
  两点采样会把一次性分配误判成增长。

### 组件级测量（单次，非基线）

| 场景 | 结果 | 说明 |
|---|---|---|
| 打开临时工作区（3 个文件，含 lazy 子树） | 首帧后立刻可交互 | 文件树按需 readdir |
| 终端 `terminal.New` + `Resize(120,40)` | 约 1.5 s 内 PowerShell 就绪并回显输入 | 首次运行会下载 `libghostty-vt` 原生库（见 dependencies.md §5.2） |
| 保存被外部修改的文件 | 弹出冲突对话框，磁盘文件未被覆盖 | documents + workspace 的 stamp 校验 |

## 尚未测量（等对应阶段）

| 状态 | 为什么现在不测 |
|---|---|
| 打开 1k / 10k / 50k 文件的 Workspace | 树是懒加载的，但还需要一个生成大目录的脚本 |
| 大文件编辑（1 MiB / 20 MiB） | P1 有 8 MiB 上限，需要定量测开文件与保存耗时 |
| 终端 / LSP / Agent 子进程的内存与 CPU | 终端已可用，但还没有随 IDE 计量的脚本 |
| IDE 与子进程的**分别**记账 | 需要把子进程 PID 一起采样 |
| Linux / macOS 运行时数字 | 本机只做交叉编译；运行时测量需要目标机 |

## 尚未测量（等对应阶段）

| 状态 | 为什么现在不测 |
|---|---|
| 打开 1k / 10k / 50k 文件的 Workspace | P1 才有真实文件树 |
| 大文件编辑（1 MiB / 20 MiB） | P1 才有真实 Buffer 管线 |
| 终端 / LSP / Agent 子进程的内存与 CPU | P2 / P4 / P5 |
| IDE 与子进程的**分别**记账 | P2 起才同时有子进程；architecture.md §8 要求分开记录 |
| Linux / macOS 运行时数字 | 本机只做了交叉编译验证；运行时测量需要目标机 |

## 已知的测量局限

1. Windows 的 `Get-Process .CPU` 精度约 1 ms，60 s 空闲测不出任何增量 ——
   这本身是结论（「无可测 CPU」），但不能声称「精确 0」。
2. 启动时间包含 Go 运行时初始化与 MyGo 后端初始化，不含杀毒软件扫描；
   冷/热缓存差异在样本里可见（72 ms vs 121 ms）。
3. 未测二进制 strip 后体积、未测 `mygo build` 打包产物（P3 接入 SQLite 时一起做）。
