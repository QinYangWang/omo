# 依赖与构建基线（dependencies）

> 状态：P2 已引入并锁定 mygo v0.7.3 与 ACP Go SDK v1.5.1。
> 本文所有版本号、许可证、`go` 指令、跨平台构建结论均在 2026-10-29 于本机实测得到，
> 命令与结果见文末「验证记录」。模块路径：`github.com/QinYangWang/omo`。

## 0. 一句话结论

技术栈可行：**MyGo v0.7.3 + ACP Go SDK v1.5.1** 两者都以 `CGO_ENABLED=0` 在
`windows/{amd64,arm64}`、`linux/{amd64,arm64}`、`darwin/{amd64,arm64}` 六个目标上交叉编译通过；
SQLite 走 purego 动态加载、不需要 cgo；不需要 Node.js 参与 IDE 运行时。
唯一需要盯住的第三方风险是 **LSP 的两个包**（见 §6），因此第一阶段不引入 LSP。

## 1. 必需依赖（已锁定）

| 模块 | 版本 | 许可证 | 模块 `go` 指令 | 用途 | 是否已实测 |
|---|---|---|---|---|---|
| `github.com/egoist/mygo` | **v0.7.3**（`go list -m -versions` 最新稳定版） | MIT | `go 1.27.3` | 原生窗口、原生 UI 工具包、代码编辑器、Ghostty 终端、SQLite、文件监听、菜单/对话框/剪贴板/无障碍 | ✅ 编译 + 运行 |
| `github.com/caelis-labs/acp-go-sdk` | **v1.5.1**（最新稳定版） | Apache-2.0 | `go 1.23` | ACP v1 类型、双向 JSON-RPC、stdio 子进程管理（含进程树清理）、有界队列 | ✅ 编译 + 内存内互通测试 |

`go.mod` 的 `go` 指令会被 mygo 拉到 **1.27.3**：本机安装的是 go1.27.0，
`GOTOOLCHAIN=auto` 自动下载了 `go1.27.3` 工具链（`$GOMODCACHE/golang.org/toolchain@v0.0.1-go1.27.3.*`）。
**结论：CI 与本机都必须预置 go ≥ 1.27.3，或允许工具链自动下载（需网络）。** 不要写成 1.27.0。

## 2. 传递依赖（由上述两者带入，无一项需要 cgo）

| 模块 | 版本 | 许可证 | 由谁引入 | 说明 |
|---|---|---|---|---|
| `github.com/ebitengine/purego` | v0.11.1 | Apache-2.0 | mygo | 运行期 `dlopen`/`dlsym` 取代 cgo；Windows 走 `syscall` |
| `github.com/go-text/typesetting` | v0.3.5 | BSD-3-Clause / UNLICENSE | mygo | 文本整形与断行（编辑器/终端排版） |
| `github.com/hajimehoshi/go-mp3`, `github.com/jfreymuth/{oggvorbis,vorbis}` | v0.3.4 / v1.0.5 / v1.0.2 | MIT / MIT / MIT | mygo | 音频插件；IDE 不用，但编译期会进依赖图（未被引用时不计入二进制体积） |
| `golang.org/x/image`, `x/net`, `x/text`, `x/sys` | v0.46.0 / v0.59.0 / v0.43.0 / v0.48.0 | BSD-3-Clause | mygo、acp | `x/sys` 是 ACP SDK 的唯一直接依赖 |

实测：`go list -deps -f '{{if .CgoFiles}}{{.ImportPath}}{{end}}'` 对整套依赖图**输出为空** ——
依赖图中不存在任何 cgo 包。mygo 模块内唯一带 `import "C"` 的文件是
`cmd/mygo/vet_ui.go`（CLI 工具，不被应用 import）。

## 3. 可选依赖：LSP（第一阶段不引入）

| 模块 | 版本 | 许可证 | 模块 `go` 指令 | 关键风险 |
|---|---|---|---|---|
| `go.lsp.dev/protocol` | v1.0.1 | BSD-3-Clause | `go 1.26` | 依赖 `github.com/go-json-experiment/json`（**伪版本**，非稳定 tag），26 个源文件直接 import；`protocol` 的联合类型编解码依赖它 |
| `go.lsp.dev/jsonrpc2` | v1.0.1（与 protocol v1.0.1 配套） | BSD-3-Clause | `go 1.26` | 同上，同样钉在 json-experiment 伪版本上 |
| `go.lsp.dev/uri` | v1.0.1 | BSD-3-Clause | — | 被 protocol 直接暴露在字段类型上（半传递依赖） |

`github.com/go-json-experiment/json` 是 Go 官方 `encoding/json/v2` 的实验前身，许可证 BSD-3-Clause，
但**版本号是 pseudo-version**（`v0.0.0-2026…-01eb4420fa68`）。它一旦改回 `encoding/json/v2` 或改 API，
`go.lsp.dev/*` 必须同步升级。这与「每项依赖都要有维护风险评估」的要求冲突。

**决策**：MVP（P0–P4）不引入 LSP。P5 再决策，三选一：
1. 接受 `go.lsp.dev/protocol` + 伪版本依赖，用 `replace` 钉死；
2. 只用 `protocol` 的**类型**（仍有 json-experiment 依赖），自写行分帧 + 自写 JSON-RPC；
3. 只实现我们需要的那几个 LSP 方法（`initialize`、`textDocument/did{Open,Change,Close}`、
   `publishDiagnostics`、`completion`、`hover`、`definition`），用 **stdlib `encoding/json`** 自写
   ~400 行客户端，零新增依赖。

第 3 项与 MyGo 编辑器的钩子面（`State.OnCompletion/OnHover/OnDefinition` +
`State.SetDiagnostics`）天然对齐，且我们只需要 LSP 的一个子集；到 P5 用实测的 LSP 报文再定。
**在 P5 之前，本文不把 LSP 列为必需依赖。**

## 4. MyGo 自带 vs 需要自研

| 能力 | 提供方 | 实测 API | 自研部分 |
|---|---|---|---|
| 原生窗口 / 生命周期 | MyGo | `mygo.App.WhenReady`、`mygo.App.Run`、`mygo.App.OnQuit`、`mygo.NewWindow(mygo.WindowOptions{Content: ui.View(fn)})` | 无 |
| 文案/i18n | MyGo `i18n`（`Catalog.Format` 运行期查表，不用 codegen；68 条文案 en/zh-Hans） | `internal/i18n` 直接调用；en 为源语言，zh-Hans 译本 | 无 |
| 原生 UI 控件 | MyGo `ui` | `Column/Row/Stack`、`Sidebar/SidebarItem/SidebarSection`、`Split/SplitVertical`、`Tabs`、`Tree/TreeItem`、`Table(*ListState)`、`Scroll`、`Toolbar`、`Modal`、`AlertDialog`、`MenuButton`、`Combobox`、`ListView`-style 虚拟化通过 `ListState` + `Visible()` | IDE 布局本身、命令面板 |
| 主题/字体/无障碍 | MyGo `ui` | `c.Theme()`、`ui.Theme`、`AccessTree`（automatic） | 语义色 token 映射 |
| 代码编辑器 | MyGo `ui/editor` | `editor.NewBuffer`、`editor.View(c, *editor.State)`、`Buffer.Snapshot/Version/Edit/Undo/Redo/MarkSaved`、`State.SetDiagnostics/ShowCompletions/ShowHover/SetInlays/Find/Fold` | 打开/保存管线、LSP ↔ 编辑器映射 |
| Diff 审查 | MyGo `ui/editor` | `editor.DiffState`、`editor.DiffView`、`DiffState.Hunks/Stats/Accept(i)/Revert(i)/GoToHunk`、`State.DiffBase` | Agent 修改的基准版本管理、接受/拒绝后回写磁盘 |
| 终端 | MyGo `plugins/terminal` | `terminal.New(terminal.Options{Command []string, Dir, Env, Conn io.ReadWriteCloser, …})`、`terminal.View(c, t)`、`Done()/ExitCode()/Send/Feed/Snapshot/Resize/Close` | 终端 Tab 管理、与 ACP `terminal/*` 能力挂钩的策略 |
| SQLite | MyGo `plugins/sqlite` | `sqlite.Open(ctx, path, sqlite.OpenOptions{})`、`DB.Execute/Query/Transaction/Close`；purego 加载 Zig 编译的 amalgamation | Schema、迁移、保留策略 |
| 文件监听 | MyGo `mygo.WatchFiles` | `WatchFiles(ctx, root, FileWatchOptions{Recursive, Ignore, Debounce, MaxDelay, MaxEntries, HintsOnly})` → `FileWatcher.Next(ctx) ([]FileEvent, error)`；事件语义为**提示**，需重读 | Buffalo 冲突协调（Buffer vs 磁盘） |
| 路径安全 | Go 标准库 | `os.OpenRoot` → `*os.Root`：禁止逃逸、禁止绝对符号链接、并发安全 | Workspace 路径规范化包装 |
| Git | 系统 `git` CLI | `os/exec` + argv 数组 | Status/Diff/Stage 封装 |
| ACP | ACP SDK | `stdio.StartClient(ctx, client, stdio.Command{Executable, Args}, acp.ConnectionOptions{})`、`ClientSideConnection.{Initialize,NewSession,LoadSession,Prompt,Cancel}`、`Process.{Shutdown,Close,Wait}` | 能力协商封装、事件归一化、权限 UI、Session 治理 |
| 进程树清理 | ACP SDK | Windows：kill-on-close Job Object；Unix：进程组 | 无需自研 |
| 有界队列 | ACP SDK | `acp.ConnectionOptions{MaxFrameSize, MaxPendingRequests, MaxHandlerConcurrency, MaxQueuedRequests, MaxQueuedNotifications, MaxNotificationBytes, MaxQueuedWrites}` | 按 IDE 需求设值 |

**注意**：`ui/editor` **不含** LSP Client，只在 `editor.State` 上开放
`OnCompletion func(CompletionRequest)`、`OnHover func(HoverRequest)`、`OnDefinition func(offset int)`
三个回调 + `SetDiagnostics(version, []Diagnostic)`。所以 LSP 适配器是**必须自研**的，且接口形状已由
编辑器给定（见 `docs/interfaces.md` 的 `LSPManager`）。

## 5. 构建与平台矩阵（实测）

命令：`CGO_ENABLED=0 go build`，程序同时 import mygo 原生 UI + `ui/editor` + `plugins/terminal`
+ `plugins/sqlite` + acp-go-sdk + `transport/stdio` + `mygo.WatchFiles`。

| GOOS/GOARCH | 结果 | 产物大小（未 strip） |
|---|---|---|
| windows/amd64 | ✅ | 19.7 MB |
| windows/arm64 | ✅ | 18.0 MB |
| linux/amd64 | ✅ | 19.4 MB |
| linux/arm64 | ✅ | 17.8 MB |
| darwin/amd64 | ✅ | 19.9 MB |
| darwin/arm64 | ✅ | 18.4 MB |

`go test -race` 在 windows/amd64 实测可用（-race 只在测试时用，不影响 `CGO_ENABLED=0` 的发布构建）。

### 5.1 SQLite 的原生库合约（必须写进打包流程）

`plugins/sqlite` 不是纯 Go：它用 purego 打开 `mygo-plugin.json` 里登记的、按平台 SHA-256 校验的原生库。
查找顺序：`MYGO_SQLITE_LIBRARY` → `mygo.App.Path(mygo.PathResources)` → 可执行文件目录 →
（未打包时）下载到 `os.UserCacheDir()/mygo/natives/<sha256>/`。

- 支持矩阵与构建矩阵一致（6 个平台/架构均有登记文件，SQLite 3.53.4 派生物）。
- `go run` / 开发期：首次运行会**联网下载**，SHA-256 校验。
- 发布：必须用 `mygo build` 打包含原生库；纯 `go build` 的包在别的机器上会报
  `sqlite: ... is missing from the app; build it with mygo build`。
- 实测（Windows）：建表 / 参数化插入 / 查询全部成功。

### 5.2 终端与 SQLite 的原生库合约

两个插件都以 purego 加载原生库，**都不是纯 Go**：

| 插件 | 原生库 | 首次使用 | 发布 |
|---|---|---|---|
| `plugins/sqlite` | `mygo-sqlite3.{dll,dylib,so}`（Zig 编译的 SQLite 3.53.4） | 未打包时下载到 `os.UserCacheDir()/mygo/natives/<sha256>/` | 必须 `mygo build` 打进去 |
| `plugins/terminal` | `libghostty-vt.{dll,dylib,so}`（Ghostty VT） | 同上（P1 实测：第一次 `terminal.New` 会下载） | 同上 |

实测（P1）：终端首次创建时打印
`terminal: downloading .../libghostty-vt-windows-amd64.dll into %LOCALAPPDATA%\mygo
atives\...`，
之后 PowerShell 正常启动、输入回显正常。**离线首次运行会失败**，
所以 CI 的 `go build` 无法覆盖这件事，必须靠 `mygo build` 打包验证（排在 P3）。

### 5.3 Go 与工具链

- 最低 Go：**1.27.3**（mygo 的 `go` 指令）。
- 不引入 `cgo`、`Zig`、`Bun`、`Node` 作为运行期依赖（mygo 文档明确：Bun 仅开发工具）。
- `go vet` 与 `mygo vet`（校验 UI 元素生命周期）都应进 CI。

## 6. 依赖替换方案（可替换边界）

| 依赖 | 万一不可用时的替代 | 代价 |
|---|---|---|
| `github.com/egoist/mygo` | 无等价替代（自绘原生 UI + 编辑器 + 终端 + SQLite 一体）。这是**架构性选择**，见 ADR-0001 | 需要更换 UI 框架，等于重写 UI 层 |
| `github.com/caelis-labs/acp-go-sdk` | 自写 ACP v1 JSON-RPC over stdio（协议本身是 JSON-RPC 2.0 + 行/帧约定）。SDK 只提供类型 + 传输 + 进程树管理 | 中等：`internal/agent/acpclient` 是唯一接触点，替换不影响 UI |
| `plugins/sqlite` | 标准库 `encoding/json` 落盘，或 `modernc.org/sqlite`（纯 Go，但体积/内存大得多） | 低-中：`PersistenceStore` 接口隔离 |
| `mygo.WatchFiles` | `fsnotify`（mygo 已内置等价实现，无需新依赖） | 低 |
| 系统 `git` CLI | `go-git`（第一版明确不引入：体积与内存换不来 MVP 价值） | 高，不做 |
| LSP `go.lsp.dev/*` | 见 §3 第 3 选项 | 低，且被 `LSPManager` 接口隔离 |

## 7. 依赖准入规则

1. 新依赖必须先在这里登记：版本、许可证、`go` 指令、为什么标准库/MyGo 做不到、替换边界。
2. 禁止 `@latest`、禁止浮动 pseudoversion（除已在 §3 说明并 `replace` 钉死的 LSP 情形）。
3. 禁止任何引入 cgo 的依赖；PR 必须附 `go list -deps -f '{{if .CgoFiles}}…'` 为空的证明。
4. 同一职责只允许一套实现：不引入第二套 UI 框架、第二套 JSON-RPC、第二套终端模拟器。

## 8. 验证记录（可复现）

环境：Windows 11 / amd64，`go1.27.0`（`GOTOOLCHAIN=auto` 拉起 `go1.27.3`），
`GOPROXY=https://goproxy.cn,direct`（`proxy.golang.org` 在本机不可达）。

```text
go list -m -versions github.com/egoist/mygo                  → 最新 v0.7.3
go list -m -versions github.com/caelis-labs/acp-go-sdk       → 最新 v1.5.1
go get github.com/egoist/mygo@v0.7.3                         → go.mod 指令升至 1.27.3
go get github.com/caelis-labs/acp-go-sdk@v1.5.1              → ok
go get go.lsp.dev/protocol@v1.0.1 / jsonrpc2@v1.0.1          → 引入 go-json-experiment/json 伪版本

# 冒烟程序同时 import：mygo、ui、ui/editor、plugins/terminal、plugins/sqlite、
# mygo.WatchFiles、acp、transport/stdio
CGO_ENABLED=0 go build                                       → 6/6 平台通过（见 §5 表）
go list -deps -f '{{if .CgoFiles}}{{.ImportPath}}{{end}}' .   → 空（无 cgo 包）
sqlite.Open + CREATE + INSERT + SELECT                       → 成功
acp.NewAgentSideConnection + acp.NewClientSideConnection over net.Pipe
  → initialize / newSession / prompt 流式 / requestPermission 全部通过（见 interfaces.md §11）
go test -race                                                → 通过
```
