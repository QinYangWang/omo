# OMO (oh-my-openagents) — Desktop 页面布局设计

技术栈：Electron + React + coss ui(主样式) + shadcn(仅补 coss 缺失组件，样式统一到 coss) + ai-elements(聊天) + Tailwind。暗色优先（参考图均为暗色）。

> 原则：**shell 极简**。会话是唯一主视图；浏览器/终端/文件/Diff 全部收进右侧 surface 面板；设置是全屏视图（复用同一窗口，左侧独立导航）。**无独立项目页**——会话按 cwd 自动归类，项目仅作为会话条目下的标签。

## 实现状态（v4，以实现为准，以下为原设计稿）

- **侧栏**：PROJECTS 固定分组（不再按时间分组）；Project 行内 `+` 新会话 + 导入按钮（弹窗列 `SessionManager.listAll()`，导入=`forkFrom` 到该目录）；顶部 `+` 添加本地目录（存 userData/projects.json）。
- **Pi 直连 SDK in-process**（`createAgentSession` + 共享 `ModelRuntime` + `SessionManager`），不走 RPC 子进程；事件经 IPC `pi:event` 推送。
- **消息渲染**：历史分页（首次 80 项 + Load older）；Tool/Thinking 卡片；用户消息时间+Copy；助手仅完整回答末尾显示结束时间/耗时/整次回答 Copy。
- **聊天框**：coss Select 模型（`getAvailable()` + `setModel`）+ Thinking 等级 + context 指示；下方 Project（含 New project… / Don't work in a project）/ Local|Worktree / Branch 选择器。
- **窗口**：`titleBarOverlay` 原生窗口键；三列 1px 可拖拽竖线；侧栏可折叠为 48px 窄条。
- **Providers**：真实 `ModelRuntime`（40 provider）列表 + checkAuth + `login()/logout()`，动态 prompt 转应用内 Dialog，凭证写 `~/.pi/agent/auth.json`。
- **配额（pi-quotas）**：复用 `@latentminds/pi-quotas` TS 源码（主进程 `tsx/esm/api` 注册后动态 import，因 node_modules 禁类型剥离）；`fetchAllProviderQuotas` + authStorage 桥接 auth.json/ModelRuntime；Provider 行内与 Usage 页“订阅配额”显示真实配额窗口（用量% + 重置时间，>70% 黄 >90% 红，可强制刷新）。
- **Usage**：`usage:snapshot` 扫描 `~/.pi/agent/sessions/**/*.jsonl` 聚合 token/费用（统计卡 + 按 provider/model 分解）。
- **Surfaces**：Browser(webview)、Terminal(xterm+裸 shell 管道)、Files(懒加载树+预览)、Review(git status/diff)。默认收起。
- **主题**：柔和暗色（#1a1a1a / #161616 / 边框 #262626），全局 7px 细滚动条无箭头。

## 0. App Shell（极简，所有视图共用）

```
┌──────────────────────────────────────────────────────────────────────┐
│ ◀ ▶ │ /会话标题(面包屑: /project 会话名)              🛈 │ ☐ │ ─ □ ✕ │
├────────────┬────────────────────────────────────────┬────────────────┤
│ ✎ New Task │                                        │                │
│ ⌕ Search   │                                        │  Right Panel   │
│            │                                        │  (surface,     │
│ Today      │        Main View                       │   可开关)       │
│ ▸ 会话A    │     (Chat 或 Settings)                 │                │
│   proj-tag │                                        │  未选时显示     │
│ Yesterday  │                                        │  "Open a       │
│ ▸ 会话B    │                                        │   surface":     │
│   novon.im │                                        │  ┌───────────┐ │
│            │                                        │  │🌐 Browser │ │
│            │                                        │  │🖥 Terminal│ │
│            │                                        │  │🗂 Files   │ │
│            │                                        │  │⎇ Review  │ │
│            │                                        │  └───────────┘ │
│ ⚙(Settings)│                                        │                │
├────────────┴────────────────────────────────────────┴────────────────┤
│ 📁 项目目录 · Local · provider/model · ctx mini · 配额警告Badge        │
└──────────────────────────────────────────────────────────────────────┘
```

- **Sidebar**：仅 New Task、Search、按时间分组(Today/Yesterday/…)的会话列表。会话条目下显示项目标签（cwd 目录名）。同目录会话自动归为一组。底部 ⚙ 进设置。
- **Right Panel (surface)**：Browser / Terminal / Files / Review(diff) 四选一，Tab 切换，cwd=当前会话目录。Explorer 不再是常驻文件树，就是 Files surface。
- 设置打开时：Sidebar 替换为设置导航（见 §3），Main 替换为设置内容，Right Panel 隐藏。

---

## 1. 会话页 (Chat) — 默认/唯一主视图

### 空态
```
┌────────────────────────────────────────┐
│              (logo)                    │
│     What should we do in omo?          │
│   ┌────────────────────────────────┐   │
│   │ Ask… / attach images           │   │
│   │ + │ model▼ │ effort▼ │ ⤴      │   │  (ai-elements PromptInput)
│   └────────────────────────────────┘   │
│   📁 omo   💻 Local                    │
└────────────────────────────────────────┘
```

### 会话中
```
┌────────────────────────────────────────┐
│ Conversation (ai-elements)             │
│  user / assistant / Tool 折叠卡         │
│  Diff/代码块内联渲染                    │
├────────────────────────────────────────┤
│ PromptInput                            │
│ [model▼][effort▼][Full access][mode] ⤴ │
└────────────────────────────────────────┘
```

- 顶部标题栏显示面包屑 `/project-name 会话首条消息…`，🛈 弹出会话信息卡（Environment、Task ID、Agent thread ID、ctx 用量%）。
- ctx 用量 mini 条在底部状态栏；点击弹出 Sheet 显示上下文分析。

---

## 2. Right Panel Surfaces

### 2a. Files
```
│ Search files…            │
│ ▸ src                    │
│ ▾ docs                   │
│   layout.md              │
├──────────────────────────┤
│ 预览: 代码高亮(shiki)/md 渲染/图片 │
│ [编辑] [保存]             │
```

### 2b. Terminal
xterm.js，多 tab，cwd=当前会话目录。

### 2c. Browser
`[←][→][⟳] url` + Electron `<webview>`。

### 2d. Review (Diff + Git 合一)
```
│ Changes          [Commit or push ▾] [Compare branch] │
│ ▾ src/foo.ts  +12 -3   [unified|split]               │
│ ▾ docs/a.md   +2  -0                                 │
│ commit 输入框 [Commit]  Branches▼ pull/push          │
```
> Git 管理并入 Review surface，不做独立 Git 页。

---

## 3. 设置（全屏视图，独立左导航，复用 shell）

```
┌──────────────┬───────────────┬───────────────────────────────┐
│ ← Back       │               │                               │
│ Search Set…  │               │                               │
│              │               │                               │
│ General      │               │                               │
│ Appearance   │               │                               │
│ Providers    │   (中间列表列   │   右侧详情/表单                │
│ Skills       │    仅 Skills    │                               │
│ Usage        │    页有,见 §3c) │                               │
│ Packages     │               │                               │
└──────────────┴───────────────┴───────────────────────────────┘
```

### 3a. General / Appearance
数据目录、默认 mode；主题/明暗、字号（coss 主题 token）。

### 3b. Providers
```
│ Providers                    [+ OAuth] [+ API Key] │
│ ● OpenAI     oauth · 已连接    quota 87%        ⋯  │
│ ○ Anthropic  apikey · sk-…a1b2                  ⋯  │
│ ⋯: 编辑 / 重新登录 / 设为默认 / 删除               │
```
- OAuth：Dialog 选 provider → 系统浏览器授权 → localhost 回调 → token 存 safeStorage。
- API Key：Dialog = provider 下拉 + 密码框 + 测试连接。

### 3c. Skills（列表+详情双栏，参考图 2）
```
┌───────────────┬───────────────────────────────────┐
│ Search skills…│  agents-sdk              [启用 ⏻] │
│ [All skills▼] │  Claude · Codex · every project   │
│ USER 16       │  描述…                            │
│ ▸ agents-sdk  │  Invoke  /agents-sdk              │
│ ▸ cloudflare  │  Path    …/skills/agents-sdk      │
│ ▸ …           │  Contents 19 files · 60.6 KB      │
│               │  [Open SKILL.md][Show in…][Copy]  │
│ 16 skills     │                        [Delete]   │
│               │  ── SKILL.md 预览 ──              │
│ [+ Install]   │  (markdown 渲染)                  │
└───────────────┴───────────────────────────────────┘
```
- Install → Dialog：搜索热门/输入名称（npm/git 源）→ `pi install`。

### 3d. Packages
同 Skills 双栏布局，对象换成 pi packages（来源 npm/git），操作：安装/更新/删除。

### 3e. Usage（参考图 3）
```
┌───────────────────────────────────────────────────┐
│ Usage   Aug 3–Sep 1   [Daily|Monthly|Projects]    │
│                       [Last 30 days▼][COST|TOKENS]│
│ RAW TOKEN COST  $0.00*  (* if billed at API rate) │
│ ───────── 趋势图 (recharts) ─────────             │
│ [Processed][Cached in][Uncached in][Output][Save] │  (统计卡行)
│ Breakdown (Table: Model | Cost | Share | Tokens)  │
│  Cost quality 边栏: Provider reported / priced %  │
├───────────────────────────────────────────────────┤
│ 订阅配额 (coss Progress):                         │
│  OpenAI Pro ████████░░ 87%  reset in 3d           │
├───────────────────────────────────────────────────┤
│ 上下文分析 (Table):                               │
│  会话 | 峰值ctx% | 系统提示 | 工具结果 | 历史 | 建议│
└───────────────────────────────────────────────────┘
```

---

## 组件归属速查

| 用途 | 库 |
|---|---|
| Conversation/Message/Tool/PromptInput | ai-elements |
| Button/Card/Tabs/Dialog/Sheet/Table/Progress/Badge/Toast/Menu/Input/Switch | coss ui |
| coss 缺失组件（样式对齐 coss 暗色 token） | shadcn |
| 图表 | recharts |
| 终端 | xterm.js |
| 高亮 | shiki |


确认后开始实现。
