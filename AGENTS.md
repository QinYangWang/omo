# AGENTS.md

给在本仓库里干活的 agent 的入口：先读什么、怎么验证、什么规矩不能破。

`omo` 是一个**Go 原生**桌面 AI 编码 IDE：没有 Electron、没有 Node 运行时、没有 web view。
UI 用 [MyGo](https://mygo.egoist.dev)（自绘），Agent 走 ACP v1（P2 核心已接）。

## 1. 文档索引

改动之前先读与改动相关的那一篇，别凭印象写。

| 文档 | 什么时候读 |
|---|---|
| [README.md](README.md) | 项目定位、当前完成度、构建与测量命令 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 分支、Conventional Commits、PR 与检查清单；提交和开 PR 前必读 |
| [DESIGN.md](DESIGN.md) | **视觉规范（样式裁判）**：token、排版、间距、颜色语义、反模式、落地流程；改任何 UI 前先读 |
| [docs/roadmap.md](docs/roadmap.md) | 阶段划分（P0-P6）与每阶段验收标准；判断一件事属于哪个阶段 |
| [docs/architecture.md](docs/architecture.md) | 模块职责与依赖规则、数据流、生命周期、**线程模型（§6）** |
| [docs/interfaces.md](docs/interfaces.md) | 内部接口形状（Workspace/Document、Agent、ACPClient、Session、事件、权限、LSP、持久化） |
| [docs/ui.md](docs/ui.md) | 当前 UI 布局、**所有截图怎么生成**、历史改造记录、已知粗糙点 |
| [docs/kit.md](docs/kit.md) | UI 设计系统 `internal/kit`：token、组件、新增一页/一条指令/一个 token 的配方 |
| [docs/security.md](docs/security.md) | 文件访问边界、Agent 授权、权限审批、日志与脱敏（改这些地方**必须**读） |
| [docs/dependencies.md](docs/dependencies.md) | 锁定版本、依赖准入规则（新增依赖前必读） |
| [docs/benchmarks.md](docs/benchmarks.md) | 冷启动 / RSS / 空闲 CPU 基线，以及怎么复测 |
| [docs/adr/0001-native-ui-acp.md](docs/adr/0001-native-ui-acp.md) | 为什么是原生 UI + ACP，不选 Electron/WebView |

## 2. 常用命令

```sh
go build ./... && go vet ./... && go test ./...          # 提 PR 前的最低要求
go run github.com/egoist/mygo/cmd/mygo@v0.7.3 vet ./...  # UI 元素生命周期检查（必跑）
gofmt -l internal main.go                                # 必须为空

CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build ./...    # 交叉编译（6 平台由 CI 跑）
CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build ./...

go run .                                                 # 跑窗口
OMO_SCREENSHOTS=1 go test ./internal/view -run TestWriteScreenshots  # 重写 docs/ui/*.png
./scripts/lucide-icons.sh                                # 刷新 internal/kit/icons/*.svg（lucide.dev）
```

- Go 版本 **1.27.3**（`go.mod`），`CGO_ENABLED=0`：**不允许**引入需要 cgo 的依赖。
- `go test -race ./...` 需要 cgo 与 GCC；本机已装 WinLibs（新 shell 刷新 PATH 后可用），
  用 `CGO_ENABLED=1 go test -race ./...`。发布构建仍必须 `CGO_ENABLED=0`。
- 终端插件（Ghostty VT）首次运行会下载原生库；headless 测试里不要创建终端。

## 3. 代码地图

```
main.go              装配：app.New → 窗口（TitleBarHidden）→ view.Shell → Run
internal/app         状态、intent（Dispatch）、命令表、终端/Agent 会话、工作区、截图模式
internal/agent       Agent Catalog、ACP raw 协议适配、进程/turn/权限治理
internal/view        窗口与面板：shell / editor / chat(ACP 会话页) / terminal / statusbar
internal/kit         UI 设计系统：token（theme.go）、组件（components.go）、图标（icons.go）
internal/workspace   os.Root 边界、读写、大小上限、watcher
internal/documents   编辑器缓冲、原子保存、磁盘冲突
internal/git         系统 git：分支、改动、HEAD 文本
internal/diff        审查基线与写回
internal/i18n        消息目录 en / zh-Hans
internal/commands    命令注册表
```

依赖规则以 `docs/architecture.md §3` 为准：`app` 不 import `view`；`view` 不碰文件系统、
不 import `git`/`documents`；`i18n` 不 import 其它内部包。

## 4. 硬规矩

### 线程与状态

- **状态只在主线程写**。视图回调在主线程同步执行，可以直接 `Dispatch`/`Run`。
- 后台 goroutine（watcher、终端退出）必须 `a.post(func(){...})` 回到主线程，再改状态。
- 状态在 `Dispatch` 之外变化后必须 `a.invalidate()`，否则界面不重绘（历史 bug）。
- **视图不写 App 字段**；要改状态就加 `Intent` 并在 `Dispatch` 里处理。
  只有立即模式绑定的东西例外：`Layout` 里的 `*string`/`*int`/`*bool`（选中页、分割比例）。

### 文案

- 所有用户可见字符串都走 `i18n.T` / `i18n.Tf`，**两个目录**（`en.json`、`zh-Hans.json`）都要加，
  key 用 camelCase，含义清楚。
- `App` 只存 `Notice{Key, Args}`，不格式化文案；视图负责翻译。

### UI

- 面板只组合 `internal/kit` 的组件，颜色/字号/行高/间距一律取 `kit.Theme`（见 [docs/kit.md](docs/kit.md)）。
  新颜色先进 token，别在面板里写 `ui.Hex("#...")`。
- 视觉规则以 [DESIGN.md](DESIGN.md) 为准：单色、少表面、句首大写、只用三档圆角与给定间距，
  不用渐变/发光/装饰图标/卡片堆叠。
- 1 DIP 分隔线用 `st.HRule()` / `st.VRule()`：`ui.Box(...).Fill()` 会两个方向都撑满，变成遮罩。
- 点击目标不能嵌套：可点元素里的按钮要写成**兄弟节点**。
- 纯图标控件必须有 `Label`（`kit.IconButton` / `kit.IconTabs` 已内置），否则无障碍树和测试都找不到。
- 图标用 `kit.Icon*`（官方 Lucide 图标，`internal/kit/icons/*.svg` 由 `scripts/lucide-icons.sh` 更新），
  **不要手抄 SVG path**，也不要在面板里内联 SVG。
- 不引入 webview；要打开网页用 `mygo.Shell.OpenExternal`（经 `app.OpenURL`）。

### 文件与安全

- 所有文件读写走 `internal/workspace`（`os.Root` 边界、8 MB 上限、拒绝非常规文件），不要直接 `os.ReadFile`。
- 保存走 `internal/documents`（原子写、冲突检测），不要绕过。
- 外部 shell/git 一律 `exec.CommandContext` + argv，绝不拼 shell 字符串。

## 5. 测试与截图

- 测试用**真实** App + `t.TempDir()` 工作区（不要 mock 到没有 IO 可测的程度）；
  依赖 `git` 的测试在没装 git 时 `t.Skip`。
- UI 测试用 `ui.NewTester` + `tt.Click("标签")` + `tt.HasText(...)`（`internal/view/shell_test.go`）。
- 组件测试放包内（`internal/kit/kit_test.go`）。
- `docs/ui/*.png` 由 `TestWriteScreenshots` 生成，**不要手工替换截图**；改了 UI 就重跑。
  新增一个窗口状态时在 `screenshots_test.go` 里加一行，并更新 `docs/ui.md` 的表。

## 6. 提交与文档

提交信息、分支命名和 PR 规则见 **[CONTRIBUTING.md](CONTRIBUTING.md)**。硬要求：

- 分支用 `<type>/<slug>`，从最新 `main` 拉；合并一律 **squash**，`main` 上不允许 merge commit。
- **PR 标题就是最终提交标题**（`<type>(<scope>): <subject>`），PR 描述就是提交正文；描述用仓库模板。
- 一个改动一个主题；如果修 bug，说清根因和"为什么以前会错"。
- 改行为就改文档，同一提交里：
  - UI 布局/截图 → `docs/ui.md`；视觉规则 → `DESIGN.md`
  - kit 的 token/组件/配方 → `docs/kit.md`
  - 阶段状态与验收 → `docs/roadmap.md`
  - 架构、线程、依赖规则 → `docs/architecture.md`（重大决策另写 `docs/adr/`）
- 提交前跑完第 2 节的前三行 + `mygo vet`，并确认 `gofmt -l` 为空；改了 UI 就重生成截图。
- 已推送到 `main` 的历史不重写（不 force-push、不 amend）；要回滚用 `git revert`。
