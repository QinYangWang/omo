# omo v2 架构提案：pnpm、多 Host 与多端同步

> 状态：架构基线，尚未替代当前实现。当前实现仍以 [architecture.md](architecture.md) 为准。

## 1. 目标与非目标

omo v2 的核心不是“把当前 Electron 应用再包装到更多平台”，而是把 **Host 作为唯一执行端**，所有界面都作为可替换的客户端：

- `omo serve` 在任意机器启动 headless Host；
- `omo` CLI 可发现本机 Host、创建或继续 Session，也可连接远程 Host；
- CLI 安装包内置 Pi SDK，不要求用户全局安装 `pi`；
- 静态 Web、Desktop、iOS、Android 和 HarmonyOS 可同时连接多个 Host；
- 同一 Host 上的 Session 在所有已连接客户端实时同步；
- Desktop 的本地 Session 与远程 Session 使用同一客户端模型；
- 新仓库使用 pnpm workspace 管理依赖、脚本和发布。

v2 第一阶段不做跨 Host 迁移中的分布式事务，也不让多个 Host 同时写同一个 Session。一个 Session 在任一时刻只有一个权威 Host 和一个写入者。

## 2. 当前结构的问题

当前版本已实现多 Server、HTTP/SSE、远程 PTY 和事件重放，但继续扩展会遇到以下边界：

1. `electron/main.cjs` 与 `server/*.cjs` 分别实现一套 Project、Pi、Provider、文件、Git 和终端逻辑，行为容易漂移。
2. Electron 本地 Agent 在主进程内运行，无法与 CLI 或其他本地界面共享实时状态。
3. HTTP 查询、SSE Agent 事件和终端 WebSocket 是三套连接；多 Host、移动端后台恢复和统一重连状态会越来越复杂。
4. `server/index.cjs` 同时负责认证、路由、静态资源和业务逻辑；`src/lib/remote-api.ts` 同时负责协议与状态恢复，测试边界不清晰。
5. 前后端契约由实现隐式维护，没有独立、可版本化且运行时可校验的 contracts 包。
6. CJS Server 和 Electron 主进程不能直接获得完整 TypeScript 类型检查。

因此 v2 不继续给 Electron 本地模式补同步，而是删除“本地特殊执行路径”：Desktop 也连接一个本机 Host。

## 3. 目标拓扑

```text
                       ┌──────────────────────────────┐
omo CLI ── Unix socket │                              │
Desktop ─ Unix/loopback│  omo Host                    │
Web ───── HTTPS/WSS ───│  - auth / workspace policy   │
Mobile ── HTTPS/WSS ───│  - project services          │
                       │  - one owner per Session      │
                       │  - Pi runtime adapter         │
                       │  - durable state / event log  │
                       │  - file / git / PTY services  │
                       └──────────────┬───────────────┘
                                      │ in-process
                                      ▼
                              Pi SDK / Agent Harness
```

每台 Host 有持久化 `hostId`。客户端配置保存 `{ hostId, name, endpoints, credentialRef }`，UI 中的全局标识统一使用：

```text
HostKey       = hostId
ProjectKey    = hostId:projectId
SessionKey    = hostId:sessionId
TerminalKey   = hostId:terminalId
```

URL 只是可变的物理地址，不参与业务主键。连接握手必须校验服务端返回的 `hostId`，避免 URL 改向后把事件写入错误缓存。

## 4. 进程模型

### 4.1 Host

Host 是唯一拥有以下资源的进程：

- Pi runtime、Provider credential 和模型目录；
- Project 与 workspace 权限；
- Session writer；
- Git、文件、PTY 和浏览器代理；
- durable operation、Session 目录和同步状态。

默认单进程即可。Session runtime 按需创建并在无 presentation attachment、无运行任务且空闲超时后回收。未来需要隔离时，在 Host 内加入 coordinator + worker，不改变客户端契约。

### 4.2 CLI

建议命令面：

```bash
omo                         # 连接或自动启动本机 daemon，进入交互界面
omo serve                   # 前台启动 headless Host
omo daemon start|stop|status
omo host add|list|remove
omo project list|add
omo session list|new|open|prompt|abort
omo --host <name-or-id> --session <id>
```

`omo` CLI 将 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 和 omo presentation 一起作为依赖发布。用户不需要全局安装 `pi`；CLI 与 Desktop 发布物使用自己锁定的 Pi 版本。开发仓库使用 pnpm workspace，并以 Node 22.19+ 作为 Host/CLI 基准运行时。

直接执行 `omo` 时先发现或自动启动本机 daemon，再进入基于 `@earendil-works/pi-tui` 改造的 omo TUI，而不是只提供管理子命令。该 TUI 保留 Pi 的 editor、消息、工具、模型、thinking、快捷键和主题能力，同时增加 Host、Project、Session 切换，连接状态，多 Host 搜索及 omo 权限提示。Agent 交互仍通过 Host service 完成，TUI 不直接持有另一份本地 Agent。

本机 daemon 使用私有 Unix domain socket；Windows 使用 named pipe。需要远程访问时才监听 TCP。CLI 不应该为每条命令创建独立 Agent 进程。

### 4.3 Desktop

Desktop 只负责窗口、系统菜单、通知、深链和系统 keychain，不再承载 Pi 业务。启动时：

1. 发现已有本机 daemon；
2. 没有 daemon 时启动随应用分发的 `omo` sidecar；
3. 通过本地 socket/loopback 连接；
4. 将本机 Host 与远程 Host 一起交给共享 client core。

当前阶段可保留 Electron。所有业务和高频路径都在随 Desktop 分发的 Node Host sidecar；若以后迁移 Tauri，只替换 shell，不影响 Host 或客户端协议。

### 4.4 Web

`apps/web` 产出纯静态资源，可由任意 CDN 或任一 Host 托管。它只保存 Host 列表和非敏感偏好；长期 Token 的浏览器存储是兼容方案，不是最终安全模型。优先支持短期 access token + refresh/session credential。

### 4.5 Mobile

移动端不使用 WebView 包装静态站点。建议：

- iOS/Android：React Native；
- HarmonyOS：React Native OpenHarmony 适配层；
- 共享 `client-core`、contracts、sync reducer、view-model 和主题 token；
- Web 的 DOM/shadcn 组件不直接共享给原生端，原生端提供对应 renderer。

网络层、secure storage、文件选择、通知和后台恢复通过 ports 注入，避免共享包依赖 DOM、Electron 或 Node API。

## 5. 建议 Monorepo 结构

```text
apps/
  cli/                    omo 命令、TUI presentation 与 daemon discovery
  host/                   Node headless Host 入口、HTTP/WSS、本地 socket
  web/                    Vite React 静态 Web
  desktop/                Electron shell；只管理窗口与 Host sidecar
  mobile/                 React Native iOS/Android
  mobile-harmony/         HarmonyOS 平台工程与适配

packages/
  contracts/              TypeBox schema、DTO、错误码、协议版本
  transport/              WebSocket/local socket framing、认证、重连
  client-core/            多 Host registry、query cache、commands
  sync/                   snapshot + ordered delta reducer、cursor 持久化
  host-core/              与网络无关的 Host use cases 和权限检查
  pi-runtime/             Pi 当前 SDK/v2 Harness 的唯一适配边界
  session-store/          Session metadata、operation 幂等、投影
  workspace/              path guard、file、git 服务
  terminal/               PTY 生命周期、offset buffer
  browser-proxy/          可选的远程浏览器代理
  ui-web/                 Web/Desktop 共用 React + shadcn 组件
  ui-native/              Mobile 共用 RN 组件和 view binding
  config/                 tsconfig、测试和构建共享配置

docs/
  adr/                     不可逆架构决策
```

依赖方向必须保持单向：

```text
apps → ui/client/host packages → contracts
host-core → pi-runtime/session-store/workspace
pi-runtime → Pi packages
contracts/sync 不依赖 React、Electron 或 Node
```

禁止 `apps/web`、`apps/desktop` 或业务组件直接调用 `window.omo`。本地和远程都通过 `HostClient` 接口。

## 6. Pi v2 包的采用策略

参考 Pi 仓库当前 `main` 分支的 0.85.1 包：

| 包 | 用途 | v2 决策 |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | 完整 coding agent、工具、Provider、资源加载及正在建设的 v2 client/server/TUI slices | omo 的直接底座；锁定版本并封装在 `packages/pi-runtime`，CLI presentation 复用其 TUI 能力 |
| `@earendil-works/pi-agent-core` | 新 Session / Agent Harness 抽象 | 由 coding-agent 使用；v2 接口稳定后成为 Host 核心依赖 |
| `@earendil-works/chord` | typed service、facet、replicated state、delta | 用于 Session observation/service，但不让 UI 直接依赖其内部类型 |
| `@earendil-works/pi-protocol` | CBOR framing、server/session/attachment route | 可用于二进制有序连接；外层认证与权限仍由 omo 实现 |
| `@earendil-works/pi-client` | transport-neutral client | 可在 WebSocket adapter 和本地 socket adapter 中复用 |
| `@earendil-works/pi-server` | Session route、多 presentation attachment | 与“一个 Session 多端附着”目标一致；稳定前只放在实验适配器后 |
| `@earendil-works/pi-session-backend-sqlite-node` | durable Session backend | 与 Node Host 匹配；仍封装在 `session-store` 后并等待 v2 schema 稳定 |
| `@earendil-works/pi-ai` | Provider/model runtime | 通常由 coding-agent/agent-core 间接使用；不要在 UI 重建 Provider 逻辑 |
| `@earendil-works/pi-tui` | Pi 自带终端 UI | omo CLI 若采用自己的多 Host UX，不应与 Host/runtime 耦合；可复用时也只位于 CLI app |

`pi-coding-agent` 已经在引入 v2：当前包依赖 Chord 与新的 agent core，源码中已有 experimental server、client、Session worker、service-only TUI、`AgentController`、`Transcript` 和 multi-presentation attachment。它不是一个已完成的稳定切换；这些入口仍受 `PI_EXPERIMENTAL=1` 控制，部分只从源码路径导出。Pi 新 server/protocol/client README 也明确说明无兼容性保证且不提供 peer authentication。

因此 omo 应定位为 `pi-coding-agent` 的更高层管理面，而不是复制或替换 Pi Harness。稳定 SDK/TUI 能力可直接复用，experimental v2 能力必须通过 `PiRuntimePort` 和 `HostTransport` 隔离、锁定精确版本，并用集成测试跟随上游演进。omo 公网认证、多 Host registry、设备权限和跨端产品状态仍由 omo 负责。

建议接口：

```ts
interface PiRuntimePort {
  attachSession(input: AttachSessionInput): Promise<SessionAttachment>;
  createSession(input: CreateSessionInput): Promise<SessionAttachment>;
  listSessions(projectId: string): Promise<SessionSummary[]>;
  close(): Promise<void>;
}

interface SessionAttachment {
  snapshot(): Promise<SessionSnapshot>;
  subscribe(listener: (update: SessionUpdate) => void): () => void;
  prompt(command: PromptCommand): Promise<AcceptedOperation>;
  abort(command: AbortCommand): Promise<AcceptedOperation>;
  detach(): Promise<void>;
}
```

当前 JSONL `SessionManager` 与未来 durable `Session`/Harness 分别实现该接口，迁移时客户端和 Host API 不变。

## 7. 统一传输与同步

### 7.1 连接

一个 HostClient 维持一条有序双向连接，复用 Session、Provider、Project 和 Terminal channel。大附件和文件下载继续走 HTTP object endpoint，避免占用实时帧。

远程连接流程：

1. `HTTPS /handshake` 获取版本、`hostId`、能力和认证方法；
2. 认证后签发短期、单次 WebSocket ticket；
3. 建立 WSS 并校验 `hostId`；
4. 订阅 Host directory；
5. 用户打开 Session 时 attach，先收完整 snapshot，再收有序 delta；
6. 断线后重新认证、重新 attach，并以新 snapshot 校准，不盲目重放 mutation。

浏览器 WebSocket 不能可靠设置任意 Authorization header，因此不要把长期 Token 放在 URL；继续使用一次性 ticket 模式。

### 7.2 Session 一致性

每个 Session 由 Host 维护：

```text
revision     单调递增的持久化 Session 修订号
runId        一次 agent run 的 ID
operationId  客户端 mutation 的 UUID
attachmentId 当前 presentation attachment
```

写命令必须携带 `operationId`。Host 在接受执行前持久化 operation result，网络重试返回同一结果。Prompt、abort、branch、rename 都遵循同一规则，不只 Prompt 幂等。

订阅规则：

- attach 首先返回完整、同一 revision 的 snapshot；
- 后续 delta 必须满足 `next.revision === current.revision + 1`；
- revision 缺口、解码失败或 Host generation 变化时丢弃局部状态并重新 hydrate；
- 不以客户端 wall clock 排序；
- Session 运行不依赖任何客户端连接；最后一个客户端断线不会 abort；
- 多端输入默认序列化到同一个 Session command queue，冲突返回明确错误。

Pi v2 的 multi-presentation attachment、Chord replicated state 和完整 snapshot hydration 与该模型吻合。当前 SQLite SSE event store 可作为迁移期实现，最终由 Session durable storage + operation ledger 替代 UI 专用事件数据库。

### 7.3 多 Host 聚合

客户端不尝试把多个 Host 合并为一个分布式数据库。`client-core` 为每个 Host 保持独立连接、revision 和错误域，再生成只读聚合视图：

- Host 离线不阻塞其他 Host；
- 排序使用展示字段，所有 mutation 必须带 `hostId`；
- 本地缓存按 `hostId` namespace；
- 删除 Host 配置只删客户端 credential 和缓存，不删除远程 Session。

## 8. 数据与安全

建议 Host data dir：

```text
~/.omo/
  host.json                hostId 与配置
  omo.sqlite               project、operation、device、审计元数据
  sessions/                Pi Session backend
  runtime/                 socket、pid、短期 ticket
  logs/
```

安全基线：

- 默认仅监听本地 socket/`127.0.0.1`；公网监听必须显式开启；
- 远程必须 TLS，或明确位于受信任 overlay network；
- 从单一 bearer token 迁移为 device credential，可单独撤销；
- 权限至少区分 read、prompt、workspace-write、terminal、admin；
- workspace 和 Session path 继续 realpath + root guard；
- Browser proxy 默认关闭，公网 Host 启用时增加目标网段/域名策略以防 SSRF；
- Desktop/mobile credential 只存系统 keychain/secure storage；
- Web 明示 localStorage 风险，优先短期凭据；
- 协议和 DTO 使用 TypeBox 在不可信边界运行时校验；
- Pi package/extension 拥有 Host 完整执行权限，安装必须是 admin 操作并显示来源。

## 9. pnpm 与 Node 运行时策略

pnpm 是 v2 唯一 package manager 和 workspace runner，Host/CLI 使用 Pi 当前要求的 Node 22.19+：

```bash
pnpm install
pnpm dev
pnpm test
pnpm check
pnpm build
pnpm --filter @omo/cli start
```

仓库根目录声明 `packageManager`，提交 `pnpm-lock.yaml`，通过 `pnpm-workspace.yaml` 管理 `apps/*` 和 `packages/*`，CI 使用 `pnpm install --frozen-lockfile`。迁移完成后删除 `package-lock.json`，禁止同时维护多份 lockfile。

- workspace 内部依赖使用 `workspace:*`；
- 可发布包通过 Changesets 或等价流程统一版本与 changelog；
- `@earendil-works/pi-*` 在 runtime packages 中锁定精确版本，避免 experimental contract 被浮动升级破坏；
- `node-pty`、图片 native addon、`node:sqlite` 和 Electron 打包在 Linux/macOS/Windows CI 做 smoke test；
- SQLite 封装在 `session-store` 后，业务层不直接导入 `node:sqlite`；
- CLI npm 包直接携带 Pi JavaScript 依赖，因此“无需安装 Pi”不等于重新实现 Pi，也不强制提供自包含 runtime；Desktop 安装包则应捆绑 Node Host sidecar 所需资源。

## 10. Extension 与 migration skill

omo 的 extension 目标不是创建另一套与 Pi 竞争的插件协议。默认策略是优先加载现有 Pi package/extension；只有遇到进程边界、presentation 或安全策略差异时才迁移。

兼容性分级：

| 旧扩展能力 | 预期兼容性 | 处理方式 |
| --- | --- | --- |
| tool、事件 hook、资源、skill、prompt、Provider | 高 | 保持在 Host/Session worker，优先原样加载 |
| 纯 slash command | 中高 | 无 UI 依赖时直接适配；否则拆分 command 与 presentation |
| `ctx.ui`、overlay、自定义 TUI component、快捷键 | 中 | 迁移为 omo/Pi presentation facet |
| 依赖进程全局变量、直接访问 TUI 实例或跨扩展私有对象 | 低 | 显式改造为 service、replicated state 或本地 presentation 能力 |
| Web/Desktop 专属界面 | 无直接兼容 | 保留 worker service，分别提供 Web 或 native renderer |

理论上底层 Agent、工具与 Pi package 机制相同，所以多数非 UI 扩展改动很小；但不能承诺零修改。v2 将 Session worker 与 presentation 分进程，远程 service 只允许 strict JSON，TUI 私有对象不能跨进程，这正是 migration skill 需要识别的差异。

随 omo 提供 `omo-extension-migration` skill，至少完成：

1. 读取扩展的 `package.json`、Pi manifest、入口和依赖；
2. 扫描 `registerTool`、`registerCommand`、事件 hook、`ctx.ui`、TUI import、全局状态和 Node-only API；
3. 输出兼容性报告，区分“可直接运行”“需要薄适配”“需要拆分 facet”“无法自动迁移”；
4. 将业务逻辑保留在 Session/worker facet，将 TUI 交互迁移到 presentation facet；
5. 为跨边界数据生成 TypeBox schema、service contract 和 replicated state；
6. 更新 package manifest，但不覆盖原入口，默认生成独立 migration branch/files；
7. 生成原 Pi TUI 与 omo TUI 的行为对照测试；
8. 对需要 Web/mobile UI 的扩展只生成 renderer 接口与 TODO，不伪造等价实现。

建议命令入口：

```bash
omo migrate extension ./my-pi-package
omo migrate extension npm:@scope/pi-extension --dry-run
omo migrate report ./my-pi-package
```

Skill 自身放在可发布的 `packages/omo-extension-migration/skills/omo-extension-migration/SKILL.md`，CLI 命令负责准备源码、工作树和验证环境，skill 负责分析与代码迁移。这样用户既能通过自然语言调用，也能获得可重复的命令流程。

## 11. 迁移顺序

### Phase 0：建立边界，不改变行为

1. 转为 pnpm workspace 和 TypeScript ESM；
2. 抽出 `contracts`、`host-core`、`client-core`、`pi-runtime`；
3. 为当前 HTTP/SSE API 建 contract tests；
4. Server 与 Electron 共用同一个 host-core；
5. 在 CI 验证 Node 22 + native dependencies。

### Phase 1：本地 Host 与 Web 统一

1. 增加 `omo serve`、daemon discovery 和 CLI TUI；
2. Web 连接同一本机 Host，并允许通过 `0.0.0.0` 从局域网或受控远程网络访问；
3. CLI 与 Web 同时打开同一 Session，验证双端 streaming；
4. 验证手机浏览器断线、切后台和重新 attach 后的 snapshot 恢复。

Desktop 当前不可用，不作为首个切片的阻塞项。Web 开发服务器可以监听 `0.0.0.0:5188`；实际远程访问优先使用 Host 在 `0.0.0.0:5189` 托管的构建产物，以获得同源 API、认证和 HTTPS。公网访问不得直接暴露无认证的 Vite 开发服务器。

这是最重要的里程碑：完成后 CLI TUI 与 Web 只剩 presentation 和 transport 差异。

### Phase 2：统一实时协议

1. 引入 Host identity、capability handshake 和统一 operation ledger；
2. 用单连接 snapshot + delta 替代按 Session SSE；
3. 接入 Pi v2 attachment/service adapter；
4. 保留旧 `/api/v1` 作为一个版本的兼容层；
5. 完成断网、重连、重复 Prompt、并发客户端和 Host 重启测试。

### Phase 3：多端产品化

1. 静态 Web 多 Host 管理；
2. React Native iOS/Android；
3. HarmonyOS adapter；
4. push notification、深链和移动端后台重连；
5. Desktop 恢复可用后再实现 sidecar 更新与崩溃恢复。

### Phase 4：可选隔离与扩展

1. Session worker 隔离和 coordinator；
2. per-device RBAC 与审计；
3. Session export/import 和显式 Host 间迁移；
4. Pi facet/plugin 的远程 presentation。

## 12. 首个可验收切片

不要从移动端或 UI 重写开始。第一个垂直切片应为：

1. `pnpm omo serve` 启动 Host，并显式允许 `0.0.0.0` 访问；
2. `pnpm omo session new --cwd ...` 创建 Session；
3. 手机浏览器打开 Host 托管的 Web 并连接同一 Session；
4. CLI 发 Prompt，Web 实时显示；
5. Web 发 follow-up，CLI TUI 实时显示；
6. 手机浏览器切后台、断线并重连后得到一致 snapshot；
7. 重复同一个 `operationId` 不会提交两次；
8. 全程没有全局 `pi` 可执行文件，且不依赖 Desktop。

该切片通过后，再迁移文件、Git、终端和 Provider 管理。这样能优先验证 omo v2 最关键的 Host ownership、内置 Pi、改造 TUI、实时同步和 pnpm 发布链路。