# CONTRIBUTING

这是 `omo` 的协作约定：**一个改动一个 PR，一个 PR 一个提交，提交信息用 Conventional Commits。**
`main` 永远是线性历史，没有 merge commit，也没有"Merge pull request #12 from someone/branch"这种自动提交。

动手前先读 [AGENTS.md](AGENTS.md)（代码规范、线程模型、UI 规矩、检查命令）。

## 1. 分支

从最新的 `main` 拉一条短命分支，命名 `<type>/<short-slug>`：

```
feat/session-list-filter
fix/diff-scroll-on-reopen
docs/kit-recipes
chore/lucide-icons
```

- `<type>` 与提交类型一致（见下），`slug` 用 kebab-case、说清做什么，别用 `wip`、`update`。
- 一个分支只做一件事；顺手的重构、格式化和无关修复另开 PR。
- 合并后分支自动删除（仓库已开 `delete_branch_on_merge`），不要重复使用旧分支。

```sh
git switch main && git pull --rebase
git switch -c feat/session-list-filter
```

## 2. 提交信息

格式（[Conventional Commits](https://www.conventionalcommits.org/)）：

```
<type>(<scope>): <subject>

<body: why, what changed, what it affects>

<footer: BREAKING CHANGE / Closes #12 / Refs #34>
```

**因为合并走 squash，PR 标题就是最终提交的标题**（仓库设置 `squash_merge_commit_title=PR_TITLE`），
PR 描述会成为提交正文。所以 PR 标题必须写成下面这种规范标题，不能是 "Address review" 之类。

### type

| type | 用于 |
|---|---|
| `feat` | 用户能看到的新能力（新面板、新命令、新交互） |
| `fix` | 修一个 bug；正文写根因和"为什么以前会错" |
| `refactor` | 不改行为的结构调整（抽 kit、拆包、改名） |
| `perf` | 不改行为、可测量的性能改善（冷启动、RSS、空闲 CPU） |
| `docs` | 只改文档（含 DESIGN.md、AGENTS.md、截图说明） |
| `test` | 只加/改测试与夹具 |
| `build` | 构建、依赖锁定、CI 脚本 |
| `ci` | `.github/workflows`、发布流程 |
| `style` | 纯格式、无逻辑变化（gofmt 一类） |
| `revert` | 回滚某个提交，正文写被回滚的 commit |

### scope（可选，用目录或领域名）

`app`、`view`、`kit`、`agent`、`workspace`、`documents`、`git`、`diff`、`i18n`、`commands`、
`desktop`（窗口/平台）、`docs`、`ci`。跨模块就省略。

### subject

- 英文、祈使句、小写开头（专有名词除外）、结尾不加句号，建议 ≤ 72 字符。
- 说做了什么，不说"更新文件"。
- 好：`fix(view): repaint when the watcher reloads a buffer`
- 差：`update code`、`fix bug`、`Changes`、`WIP`

### body

- 说**为什么**：原来的问题、现在为什么这样、影响面（其他平台？旧数据？）。
- 改 UI 写清视觉依据（DESIGN.md 的哪条），并说明截图的 diff。
- 修 bug 写清根因，能一句话说清"以前为什么错"。
- 不写"按计划完成了任务"这类过程流水。

### footer

- `Closes #12` / `Refs #34`；破坏性改动写 `BREAKING CHANGE: ...`。

## 3. PR

- 标题 = 规范提交标题（见上）；CI 的 `pr-title` 会按 `^(feat|fix|…)(\(scope\))?: ` 检查，不符合就红。
  描述用仓库模板（`.github/PULL_REQUEST_TEMPLATE.md`）：
  做了什么 / 为什么 / 怎么验证 / 截图（UI 改动必附，来自 `docs/ui/*.png` 的重生成结果）。
- 一个 PR 只解决一件事；顺手发现的问题另开 issue/PR。
- 提交前本地跑完检查（见 §5），CI 会在 Linux/macOS/Windows 上再跑一遍。
- 合并方式是 **Squash and merge**；仓库已关闭 "Create a merge commit" 和 "Rebase and merge"，
  所以 `main` 上不会出现 merge commit。合并后删除分支。
- review 意见用新提交修正没关系，squash 时都会折进同一个提交。

## 4. 本地 git 配置（建议）

```sh
git config pull.rebase true      # 拉取永远 rebase，不产生 merge commit
git config merge.ff only         # 合并不知何时产生 merge 就报错
git config push.default current  # 推同名分支
git config commit.cleanup strip  # 提交信息去掉注释行
```

## 5. 提 PR 前必须过

```sh
gofmt -l internal main.go                                  # 必须为空
go build ./... && go vet ./... && go test ./...
CGO_ENABLED=1 go test -race ./...                          # 需要 GCC；CI 也跑
go run github.com/egoist/mygo/cmd/mygo@v0.7.3 vet .    # UI 元素生命周期
```

- 改了 UI：`OMO_SCREENSHOTS=1 go test ./internal/view -run TestWriteScreenshots` 并检查 `docs/ui/*.png` 的 diff。
- 改了行为：同一提交里更新对应文档（`docs/ui.md` / `docs/kit.md` / `docs/roadmap.md` /
  `docs/architecture.md` / `DESIGN.md`），见 [AGENTS.md](AGENTS.md) §6。
- 新增依赖：先过 [docs/dependencies.md](docs/dependencies.md) 的准入规则。

## 6. 历史

`main` 不重写历史（不 force-push、不 amend 已推送的提交）。需要回滚用 `revert` 提交。

2026-10-30 做过一次性的历史整理：把 P0 到 P2 的开发提交（含一个 PR merge commit）压成一个提交
`feat: native Go AI coding IDE with ACP v1 agents`，并从这一版开始执行上面的 squash-only 规则。
