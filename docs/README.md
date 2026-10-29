# omo — 设计文档索引

Go 原生 AI Coding IDE + ACP Client。模块路径 `github.com/QinYangWang/omo`。
**当前状态：P0 骨架已落地并通过验收**（真实原生布局、命令路由、i18n、启动与空闲基线）。

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 系统架构图、模块职责与依赖规则、关键数据流、ACP 时序图、Workspace/进程/连接/Session 生命周期、线程模型、内存分账 |
| [dependencies.md](dependencies.md) | 已核实的依赖版本/许可证/`go` 指令、6 平台 `CGO_ENABLED=0` 构建矩阵、MyGo 自带 vs 自研对照、替换方案、验证记录 |
| [interfaces.md](interfaces.md) | 关键 Go 接口草案（Workspace/Document/ACPClient/ProcessManager/SessionManager/Registry/PermissionManager/LSPManager/Persistence）、核心结构、Session 状态机、Fake 测试骨架 |
| [security.md](security.md) | 信任模型（不假装沙箱）、文件访问边界（`os.Root`）、Agent 启动授权、ACP 权限流程、日志脱敏与保留上限 |
| [roadmap.md](roadmap.md) | P0–P6 阶段、验收条件、风险表、P0 完成记录与 P1 清单 |
| [benchmarks.md](benchmarks.md) | 实测基线（启动 / 空闲 CPU / 内存）与测量局限 |
| [adr/0001-native-ui-acp.md](adr/0001-native-ui-acp.md) | 为什么 MyGo 原生 UI / ACP v1 / 独立进程 Agent / 不绑定 Pi Durable / 复用 MyGo Editor·Terminal·SQLite |

## 已确认的决策（2026-10-29）

| 事项 | 结论 |
|---|---|
| 模块路径 | `github.com/QinYangWang/omo` |
| 起步阶段 | P0（已完成），P2 的 ACP 层可与 P1 并行开发（包边界独立） |
| P2 首个真机验证 Runtime | **codex** 与 **pi**（两个，用来覆盖 `loadSession` 等能力差异） |
| P5 LSP 方案 | **选项 B**：自写 ~400 行 LSP 子集客户端，用 stdlib `encoding/json`，不引入 `go-json-experiment/json` 伪版本依赖 |
| 未知 `sessionUpdate` 变体 | P2 先接受「只记诊断」的妥协；P3 再评估改用 `acp.NewConnection` + 自写 handler |

## 一页结论

- 技术栈可行且已实测：**MyGo v0.7.3**（原生自绘 UI + 编辑器 + Ghostty 终端 + purego SQLite + 文件监听）
  \+ **acp-go-sdk v1.5.1**（ACP v1、stdio 子进程与进程树管理），二者均无 cgo，
  Windows/Linux/macOS × amd64/arm64 六目标交叉编译通过（P0 产物 15.2–16.9 MB 未 strip）。
- Go 最低版本 **1.27.3**（由 mygo 决定），不是 1.27.0。
- 唯一需要盯住的第三方风险：LSP 的 `go.lsp.dev/*` 依赖实验性伪版本 `go-json-experiment/json`，
  因此 P5 走选项 B，**不引入**。
- 已复现的 ACP 兼容性缺口：**未知 `sessionUpdate` 变体会被 SDK 丢弃**（连接存活、回调不触发）。
  已有诊断 + 局部逃生舱方案，不影响 UI 层。
- 安全上不假装沙箱：ACP 的 `fs/*`、`terminal/*` 是「客户端代 Agent 做事」，
  不声明也不阻止 Agent 自己读写。IDE 的能力是**边界检查 + 审批 + 变更检测**，不是隔离。

## 工程约定

1. 代码注释、标识符、提交信息用英文；产品文案走 `internal/i18n` 的 catalog（en 为源语言，zh-Hans 译本）。
2. 视图层（`internal/view`）不得 import ACP SDK、SQLite、进程 API。
3. App 状态只在主线程写；后台 goroutine 必须经 `Window.Update(fn)` 回到主线程。
4. 新依赖先登记进 `dependencies.md`，并附「无 cgo 包」证明。
