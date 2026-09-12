# omo v2 实现规划：多端协作、动态插件与高并发运行时

> 状态：已按用户确认的产品边界修订；技术方案待验证，不是已实现功能说明。
>
> 调研基线：omo 提交 `f7810ae`；本地安装的 Earendil 包版本为 `0.85.0`。上游设计文档对照该版本的 npm `gitHead`：`107d79f11072bbc8a3a757ed7fd69596bee7d68c`。
>
> 本次仅新增规划文档，不修改业务代码、依赖或 v1 运行方式。性能指标是待验证目标，没有执行性能基准，也不代表 Bun 已优于 Node。

## 1. 结论与建议

**建议推进 v2，但应重构“产品运行时与状态所有权”，而不是仅将 `pi-coding-agent` 替换为四个底层包。**

v2 的产品定位应从“Pi 的 Desktop / Web 界面”变为：

> **拥有持久任务、多端协议和插件生命周期的 Agent 工作平台；Pi 提供模型与执行基础，omo 掌握产品语义。**

关键决策：

1. **一个用户控制的权威 daemon，多端只是客户端。** 所有端可连接同一台电脑；电脑关机、休眠或不可达时显示离线，其会话不能查看或操作。不建设常在线云副本、自动接管或离线会话阅读能力。
2. **优先复用新的 `AgentHarness` / `Session`，不要默认从 `Agent` 重写全部功能。** 当前 `pi-agent-core` 已不只是内存 Agent loop，但新接口必须经过恢复、事务和性能验证。
3. **持久化、实时复制、遥测分别设计，已确认操作要求掉电 RPO=0。** Session Storage 是执行事实；omo 数据库存储产品事实；Chord 是实时服务与状态投影；Telemetry 只做诊断。持久确认必须发生在可靠落盘之后。
4. **可信、自生成插件，不做市场和 Pi 扩展兼容层。** omo 提供 UI 组件、类型化插槽、插件 SDK 与 skill 教程；Agent 生成 / 改写插件，通过不可变产物、分代运行和安全切换点热启用。UI 插件是首版能力，不只提供工具插件。
5. **容量以 100 个独立 Session Worker 进程同时推进会话为基准。** 多项目共享调度、存储和插件基础设施；100 个排队任务、Promise 或模型连接都不能替代该指标。Node 先建立正确性基线，Bun 在同等持久性和进程拓扑下比较。
6. **保留现有 Windows / macOS / Linux Electron 与 Web / Server 资产。** 不为 v2 重写已有客户端；移动端优先 React Native + React Native OpenHarmony，共享协议与业务模型，终端和文件编辑纳入移动端首版。

### 1.1 三个目标的优先级

| 优先级 | 目标 | 首要结果 |
| --- | --- | --- |
| P0 | 多端同步与可靠执行 | 唯一 daemon / Session 写者；掉电不丢已确认操作；离线不提供会话查看和操作 |
| P0 | 自生成 UI / 工具插件 | 组件 SDK + skill 教程；动态启用 / 替换可控；坏插件不能拖垮控制面 |
| P0 验证 / P1 加固 | 100 个并发会话进程 | 100 个独立 Worker 跨项目真实推进；记录整棵进程树资源，所有队列有界 |
| P2 | Bun 与进一步性能优化 | 只有端到端收益明确、兼容性及同等掉电持久性达标时才替换运行时 |

### 1.2 首版不承诺

- 多台离线机器同时执行、修改同一个会话，然后自动合并所有副作用。
- Pi 扩展 / TUI 的运行时兼容、第三方插件市场或任意恶意代码的通用安全托管。
- 插件源码改变后，任意执行栈在任意指令处无损迁移。
- 服务器崩溃后恢复原有 HTTP 流、Promise、文件描述符或 shell 进程。
- 对任意 shell、第三方 API、模型请求提供端到端 exactly-once。
- 自动同步整个项目文件树、实时协同编辑器、通用分布式工作流平台。

这些不是“暂时少做一个功能”，而是必须明确的系统边界。

### 1.3 已确定的产品范围

- **v2.0**：Windows / macOS / Linux 桌面和 Web / Server；共享 daemon、持久命令、可信动态 UI / 工具插件、100 个并发会话进程。
- **移动端首版**：优先 React Native，共享框架覆盖 iOS / Android / 鸿蒙；会话、终端、文件查看和编辑均属于范围，不降格为通知 / 审批遥控器。
- **离线语义**：只显示连接目标离线，不使用缓存继续浏览该 daemon 的会话、文件或终端；未发送草稿可在设备保留，但不变成离线执行队列。
- **插件来源**：用户或 Agent 在受信任范围内生成；没有市场、商店审核和 Pi API 兼容承诺。安全工作聚焦权限误用、凭据边界、错误代码和资源失控。
- **可靠性边界**：在受支持且正确兑现同步写语义的存储栈上，已确认操作掉电零丢失；单盘物理损毁、存储设备虚报 flush 和任意外部副作用的一次性执行不包含在该承诺中。
- **对照对象**：DeepSeek Harness 扩展 cookbook 的「UI 插件」及其链接的 Conversation / Slots / Client 模块文档，详见第 7 节。

## 2. v1 的限制：哪些来自 Pi，哪些来自 omo

参照 [现有架构](architecture.md)、[会话机制](sessions.md)、[可靠性](reliability.md) 与实际源码。

| 现状 | 影响 | v2 应对 |
| --- | --- | --- |
| Electron 本地在 `electron/main.cjs` 执行，远程在 `server/pi-service.cjs` 执行 | 生命周期、持久性和功能容易分叉；本地会话不自然加入跨端同步 | 统一 daemon 与领域服务；Electron 只保留原生桥接 |
| Pi JSONL 保存历史，omo SQLite 保存实时事件，UI 再维护正文缓存和序号 | 历史、流式尾部和进程内状态需要反复校准 | 明确唯一执行事实源、快照水位及可重建投影 |
| TUI 与 omo 通过 `fs.watch`、文件大小和 Turn 数变化同步 | 是文件变更提示，不是多写者协调协议 | JSONL 退为导入 / 导出格式，不作为协作总线 |
| Agent 缓存以调用方 Session ID 为键，另有持久 ID / 路径别名 | 跨客户端必须额外保证不同别名不会创建重复写者 | 服务端分配规范 Session ID；连接 ID 不参与执行身份 |
| Prompt 先保存响应，再启动异步 `session.prompt()` | 存在“已记录请求但未真正执行”的崩溃窗口；查询后写入也不等于并发去重事务 | 持久命令收件箱、原子受理与结果查询 |
| Server 会话、history、watcher 使用 Map；未见与桌面等价的空闲回收策略 | 打开大量会话可能累积资源 | 统一租用、回收与预算机制 |
| 每个原始 Pi 事件同步 SQLite 写入，随后序列化推送 | `message_update` 含增长中的消息，可能形成重复全文存储与序列化开销 | 紧凑 frame、提交边界、批量复制与有界日志 |
| Remote API 按 Session 建立事件流，收到事件先写 localStorage 序号 | 大量会话的连接与主线程同步写入成本；游标不能独立于成功应用状态提前确认 | 连接多路复用；状态和已应用游标一起持久化 |
| SSE 历史查询默认最多 5000 条，旧事件又会按 retention 清理 | 完整补齐需要显式分页与过期游标重置，不能只建立实时订阅 | `reset_required`、快照与重放协议 |
| 扩展执行依赖 `ctx.ui`、TUI Component、终端输入或全系统权限 | 加载扩展不等于能提供跨端交互或安全执行 | 原生 omo 插件契约、声明式交互与隔离宿主 |

以上是结构性风险分析，不等于已经通过故障注入复现了每一种错误。

### 2.1 不应误判 Pi 的能力

`pi-coding-agent` 本身支持 SDK、Session JSONL 持久化、扩展状态、`/reload` 和自定义资源加载。SDK 文档也明确列出 Web / Desktop / Mobile 集成用途，并支持从外部存储恢复内存 SessionManager。

因此问题不是“Pi 完全不能持久化或扩展”，而是它的 CLI / TUI 产品语义并不自动提供 omo 所需的：

- 多客户端共享身份、授权、命令排序与持久任务调度；
- 跨进程唯一写者、明确的重启恢复策略；
- Web / 原生移动端可理解的扩展交互契约；
- 用户生成代码的隔离、发布、回滚与资源配额。

仅更换包而不补上这些边界，会重现当前问题。

## 3. 四个基础包：已确认能力与使用边界

### 3.1 能力矩阵

| 包 | `0.85.0` 已确认能力 | 不应假定它提供 |
| --- | --- | --- |
| `@earendil-works/pi-ai` | Provider / Models、认证抽象、流式模型接口、工具 schema、usage、紧凑 `AssistantMessageFrameEncoder` 与 reducer、测试用 faux provider | 应用级任务调度、多端会话数据库、执行副作用的一次性保证 |
| `@earendil-works/pi-agent-core` | `Agent`；新的 `AgentHarness` / `AgentLane`；Session / Storage / Repo；分支、队列、操作状态、恢复、压缩、技能、工具、ExecutionEnv、遥测 schema | 完整稳定的产品后端、账号系统、分布式调度、插件权限平台 |
| `@earendil-works/chord` | Facet 生命周期、依赖图、稳定服务句柄、singleton / keyed 服务、复制状态、JSON delta、远程服务适配边界、Node 构建与分代加载、同形替换 | 数据库、CRDT、网络监听、认证、离线命令队列、安全沙箱、现成原生移动 SDK |
| `@earendil-works/pi-telemetry` | 显式 Context / Span 契约、NOOP、内存参考实现、类型化 schema 和 adapter conformance | 持久业务日志、指标数据库、exporter、默认 OpenTelemetry 后端 |

### 3.2 重要发现：core 已有新的持久 Harness

应优先验证并复用：

- `AgentHarness.create()`：连接一个已打开的 Session，返回 Harness 和未完成操作清单；创建本身不应被当作自动恢复所有副作用。
- `AgentLane.accept()` / `drive()`：分离操作受理与推进，比“HTTP 一直等待 `prompt()` 完成”更适合 daemon。
- `inspectExecution()` / `getResult()` / `requestAbort()`：面向明确 operation ID 的查询和取消。
- `steer()` / `followUp()` / `nextRun()`：已有队列语义，但 omo 的网络幂等仍需额外保证。
- `Session.mutate()` / `Storage.commit()`：有明确的排他变更和提交边界。
- `AgentHarnessToolInvocation`：稳定 `invocationId` 与持久 memo；工具可声明 `replay: "safe"`，默认不安全重放。
- `ExecutionEnv`：文件与 shell 抽象；core 也已包含压缩、分支摘要、技能、模板、基础工具等能力。

**不建议直接从 `new Agent()` 开始重写所有这些功能。** 只有新 Harness 的验证门槛未通过时，才评估更窄的自有执行适配器。

### 3.3 已发现的缺口与风险

1. **接口存在不代表实现完整。** 当前 `AgentHarness.watchSession()` 的运行实现仍抛出 `SliceNotImplemented("watchSession")`。会话目录和全局运行状态应由 omo 投影服务维护，不能直接依赖它。
2. **`lane.watch()` 不等于无限历史分页服务。** 当前快照围绕 lane、最近压缩边界和进行中的操作构造；仍需 omo 的完整历史查询与分页投影，不能把它直接广播为每个客户端的全部会话数据。
3. **`accept({ operationId })` 不是已验证的网络幂等 API。** 当前实现有 lane busy 检查，但不能据此推导重复提交始终返回原结果；需在 omo 受理层实现去重、payload 校验和恢复对账。
4. **当前 memo API 是 `getMemo()` / `setMemo()`。** 某些上游设计示例出现的 `memoOnce()` 不能当作已发布能力。审批的 first-writer-wins 必须有实际事务或 CAS 支撑。
5. **进度持久化仍有性能成本。** core 已使用紧凑 frame，但当前 progress 路径仍会逐项提交；不能把“换用 core”直接等同于“写入自动批处理”。
6. **Chord 普通 reload 仅适用于同形服务图。** 改变 facet 集合、依赖、服务模式或远程成员形状需要另行构建宿主 / 图；通用结构替换与对称 RPC 在其规划中仍有未完成项。
7. **Chord reload 不自动 drain 已进入的旧调用。** 单个 singleton 可直接替换，但多服务切换不是数据库式原子事务，切换后失败可能终止宿主。
8. **上游设计稿与已发布代码存在差异。** 部分实验文档仍使用旧 `state.set()`、不同 reload 顺序等；落地以固定版本 public exports、实现和测试为准。

### 3.4 SQLite 不需要从零开始，但所有权必须自建

已核实另一个已发布包：`@earendil-works/pi-session-backend-sqlite-node@0.85.0`。它不是当前 omo 的直接依赖，本次仅阅读了 npm 发布包的文档与类型，没有安装。

可优先验证其 `SqliteSessionRepo`：

- 默认每 Session 一个 SQLite 文件，也支持多个 Session 共用指定容器。
- 使用可注入 `SqliteDatabaseFactory`，默认是 `node:sqlite`。
- **明确不提供跨进程 lease、lock、fence、heartbeat 或 takeover。** 宿主必须保证一个 Session 只有一个写者。
- 同步 SQLite transaction 的 callback 不能返回 Promise；异步接口外观不意味着数据库工作不阻塞事件循环。
- 不自带搜索 / FTS 服务，目录和搜索属于独立投影。

建议先复用并运行其 Session / Storage conformance；Bun 适配器或自有 Storage 只在测量和功能缺口证明有必要时实现。

### 3.5 omo 必须自己掌握的层

- 稳定的产品 ID、协议 schema、版本协商与鉴权。
- 命令幂等、任务队列、调度、公平性、预算与取消树。
- 插件管理器、隔离宿主、能力授权、发布和状态迁移。
- 历史 / 目录 / 运行状态投影、在线缓存、离线禁用与重连恢复协议。
- 数据迁移、备份、审计、移动端接入和部署生命周期。

这些通过 omo 的适配器封装，客户端和普通插件不直接依赖上游 Harness 内部状态结构。

### 3.6 依赖策略与重构成本

下沉到 core 不等于天然获得更稳定的 API。当前几个包来自同一快速演进的上游，新 Harness 与 Chord 仍需承担版本变化风险；v2 的收益应来自 omo 掌握边界，而不是相信底层永不变化。

- v2 将实际使用的四个包声明为直接依赖并固定验证过的版本，不依赖 `pi-coding-agent` 的传递安装，也不自动追踪 `latest` / 宽松版本范围。
- Chord、工具 schema 和宿主 SDK 的共享运行时通过 peer / externals 统一，避免插件打包出第二份带有不同 branding 的 Chord 实例。
- 上游 Session storage version、omo 数据版本、公开 protocol version、plugin SDK version 分别管理，升级前运行数据 fixture 和契约测试。
- 优先贡献上游修复或实现窄 adapter；若持久受理、权限或恢复需要大量侵入式修改，应暂停迁移并重新评估，而不是在新底层上继续堆兼容补丁。
- 自建的主要长期成本是协议、调度、安全、迁移和运维；不要同时承担 Provider 协议、Agent loop、压缩算法与所有基础工具的重新实现成本。

## 4. 目标架构

### 4.1 先做模块化 daemon，不先拆微服务

```text
Web                 Electron              React Native / OpenHarmony
 │                窗口 / 原生桥接             原生视图 / WebSurface
 └──────────────────────┬─────────────────────────┘
                omo Protocol / Client SDK
                        │ HTTPS + WSS
              一个用户控制的 omo daemon
                 ├─ Control Plane：身份 / 命令 / 同步 / 插件管理
                 ├─ Supervisor & Scheduler：Session 所有权 / 进程 / 预算
                 ├─ Storage / Artifact：可靠提交与可重建投影
                 └─ Credential / Plugin / Process / PTY brokers
                        │ 有界内部消息通道
                 Session Worker × 100（容量目标）
                 ├─ 每个进程拥有一个活跃根 Session
                 ├─ AgentHarness → 主 lane / 子 Agent lanes
                 ├─ 按需加载的 pi-ai Provider adapter
                 └─ Session Storage adapter / capability client
                        │
            按需共享的 Plugin Host、工具进程与 PTY
```

这里的 daemon 是一个服务部署单元，不是“只能有一个 OS 进程”。控制面仍是模块化单进程，但**根 Session 的执行基准改为一会话一 Worker 进程，100 个可同时推进**。这不是重新引入 Pi RPC CLI 子进程：每个 Worker 内嵌 core SDK，使用 omo 自有内部契约。

`Runtime Host` 在下文指这类执行宿主；首版具体实现是 Session Worker。Supervisor 按 workspace 分组实施策略和预算，不把同项目的全部根会话偷偷合并到一个进程来满足容量目标。子 Agent lane 默认仍在所属 Session Worker 内，不递归一子 Agent 一进程。

**一个 Session 的全部 lane 和写入权始终属于同一个 Worker。** 独立存储进程若被采用，只是受所有权约束的 I/O 服务，不成为第二个 Harness 写者。共享存储的可行路径及验证门槛见第 5、8 节。

### 4.2 桌面本地与远程只差连接地址

- Electron 不再直接创建 `AgentSession`，负责 daemon 启动 / 配对、窗口、文件选择、系统通知、凭据存储。
- 本地客户端与远程客户端使用同一领域契约；可以有 loopback 优化，但不能有第二套业务语义。
- daemon 不运行 Pi TUI / RPC CLI 子进程；由它监督的每个 Session Worker 在自己的进程内嵌 core SDK。
- 后台持续执行采用独立 daemon / OS service 生命周期，不能把 Electron 子进程“看起来分离”当作跨退出持久服务。
- 默认监听 loopback；允许手机连接需要显式开启 TLS 访问、受控隧道 / VPN 或反向代理，不能默默暴露端口。
- 用户明确选择“仅随桌面运行”还是“后台服务”；退出整个 daemon 时展示未完成任务并执行既定恢复 / 终止策略。电脑关闭后，无论是哪种模式，其他客户端都显示该 daemon 离线。
- 复用现有三平台 Electron 打包、Web / Server 接入、终端、文件与 Git 能力；新增重点是 daemon 服务生命周期、进程监督和协议一致性，不是从零重做这些功能。Windows 服务 / Job Object、macOS LaunchAgent、Linux user service 的具体封装分别验证。

这会改变 v1“在 Electron 主进程或 Server 内运行”的部署边界，属于 v2 的独立架构决策；实施时另行更新项目约束与文档。

### 4.3 多端同步不等于多服务器多主

产品已确认：**所有客户端可以连接同一个用户控制的 daemon；它不必常在线。** 一个 daemon 管理多个项目及其会话，不需要额外 Hub、云端 Session 副本或 Runner 网络。

- daemon 在线且授权有效时，桌面、Web、移动端看到同一权威状态，可以提交输入、审批、取消、使用终端和编辑文件。
- 关机、休眠、断网或连接失效时，客户端进入 `offline`：显示 daemon 名称 / 最近在线时间，停止操作入口，隐藏当前会话正文、文件与终端内容。不以缓存页面冒充仍可访问的会话。
- 客户端可保留认证材料、连接配置、未发送草稿及用于恢复的内部缓存；这不授予离线浏览能力。重新在线并完成鉴权 / 快照校准后才重新开放会话。
- 离线时不接收待自动补发的执行命令。断线前已发出但回执未知的命令，重连后按原 command ID 查询 / 对账，不能换 ID 重发；这与新建离线命令不同。
- 网络重连到原 daemon 不要求搬迁 Session；进程重启则按持久记录恢复。客户端不能通过切换地址伪造另一个写者。

Hub / Runner、自动接管、多主合并、离线阅读与自动迁移均从当前路线移除。若将来用户改变这一产品边界，再另立 ADR，而不是现在为它们付出实现成本。

## 5. 数据、命令与持久执行

### 5.1 统一术语

| 实体 | 含义 |
| --- | --- |
| `Workspace` | 目录、仓库与执行策略的逻辑边界；路径是执行端私有属性 |
| `Session` | 长期会话身份、历史树与执行记录，不等于窗口、连接或活跃 Agent 对象 |
| `Branch` | 会话历史树上的命名位置；不是 Git branch |
| `Lane` | Session 内一个串行执行通道；可对应主 Agent 或协作子 Agent |
| `Run / Operation` | 一次可受理、推进、查询、取消、恢复的工作 |
| `Task` | omo 调度单元；可绑定 Run、子任务、外部进程或等待条件 |
| `Interaction` | 持久待办交互，如问题、权限审批；不归某个客户端窗口所有 |
| `Artifact` | 图片、大输出、补丁、构建结果等不可变内容对象 |
| `PluginGeneration` | 某插件的一份确定源码、依赖、产物与权限版本 |

UI 的 Conversation Turn 与模型的一次 assistant + tools turn 不同，协议和存储不能混用。UI Turn 使用稳定 ID，不再靠正文数组下标推导身份。

### 5.2 三类状态，三个所有权

| 状态 | 权威位置 | 示例 |
| --- | --- | --- |
| 执行事实 | core Session Storage | transcript、branch tip、lane 配置、operation、执行队列、usage、恢复 memo |
| 产品事实 | omo 持久存储 | 用户 / 设备、workspace、命令、调度、插件版本、审批、artifact 元数据、审计 |
| 派生 / 临时状态 | 可重建投影或客户端缓存 | 目录摘要、当前流式视图、在线设备、滚动位置、展开状态 |

可以物理共用数据库，也可以分库，但每类事实只能有一个权威来源。**不要在 omo 再维护一份独立可写 transcript 和一套与 Harness 竞争的 operation 状态机。**

### 5.3 建议存储布局

- 控制面 SQLite：身份、workspace、command inbox、调度记录、插件元数据、artifact 索引、审计。
- 执行存储：以 100 个独立 Session Worker 为前提，比较“每 Worker 独占一个 Session 库”与“少量 Storage Host 管理共享容器”的句柄、WAL、锁、IPC、fsync 和冷启动成本。
- 目录 / 搜索 / UI history：可丢弃、可重建的索引；不能成为另一套执行事实。
- Artifact Store：本地内容寻址文件，未来可接对象存储；按需读取，不把 base64 图片反复塞进事件和快照。

同一共享 SQLite 容器优先由一个 Storage Host 管理，不让 100 个 Worker 各开写连接争抢 WAL。这里是拟议的 omo 存储架构，不是 `SqliteSessionRepo` 自带 IPC / group commit；其 `SqliteDatabaseFactory` 的同步事务不能直接代理成异步跨进程 callback。若采用共享宿主，应在 core 异步 `Storage` 边界实现并验证窄适配器，详见 8.6。SQLite 文件不放在网络共享目录供多个主机并发写。

### 5.4 命令受理必须可证明

所有有副作用命令采用以下**拟议 omo 契约**：

```text
commandId / clientMutationId
scope: workspaceId + sessionId + laneId（按命令类型选取）
kind + payload + payloadHash
expectedRevision / expectedOperationId（适用时）
```

身份由认证上下文注入，不能信任 payload 里的 `userId`。去重键至少绑定 principal、目标范围与 mutation ID；相同键携带不同 payload 应拒绝，不返回另一次调用的成功。

状态示例：

```text
received → queued → admitted → running / waiting → completed / failed / cancelled
```

受理流程：

1. 校验身份、范围、附件、schema、配额与业务前置条件。
2. 在一个事务中写入去重记录、durable inbox 和适用的稳定 operation ID；等待满足 5.8 的同步落盘后，才返回带 command ID 的 `202 queued` 持久回执。这表示“已可靠入队”，不是模型已开始或工作已完成。
3. Scheduler 使用该固定 operation ID 调用执行适配器；执行侧原子保存受理事实并可靠落盘后发布 `admitted`。
4. 结果丢失时根据同一个 command / operation 查询和恢复，不换新 ID 再执行。
5. 客户端可以查询“排队 / 已受理 / 运行 / 结果”，不能以 HTTP 成功冒充任务完成。

**跨库一致性是先行验证项，不可省略：**

- 同库可在支持的事务边界内保存变更与 receipt / outbox。
- 分库必须使用 durable inbox / outbox、稳定 ID、执行侧去重与启动对账；不能假装两次数据库写入是原子操作。
- 对 `accept()` 可基于固定 operation ID、当前操作和持久结果实现受控对账；对队列追加、审批等仍需证明 receipt 与实际状态变化的原子性。
- 如现有公开接口不能承载这种边界，应实现窄的 Storage / admission 适配器或向上游补足能力；未证明前，不宣称“所有命令 exactly-once”。
- 不在 `Session.mutate()` 回调里 await 会再次获取同一 mutation barrier 的公开写方法；这会死锁。只使用该次提供的 mutator。

### 5.5 唯一写者与恢复

首版只允许一个 daemon 管理一个数据目录，使用 OS 级所有权机制，禁止第二个 daemon 同时启动为写者。

- Supervisor 持有规范 Session → Session Worker PID / 实例 token / ownerEpoch 映射；客户端 attachment 不拥有 Session。
- Worker 更换时，先确认旧进程停止、旧提交通道关闭并释放写入权，再打开新 Session；Storage Host 在每次写入边界校验所属 Worker 的 epoch。
- 引入 `ownerEpoch` 拒绝迟到结果，但 epoch 只有在写入 / 执行边界实际校验才有意义。
- 无法确认旧写者停止时，不根据超时强行启动第二个写者。
- 若未来支持跨主机自动接管，必须在存储 / 执行 broker 强制 fencing；仅有数据库里的 lease 字段或 Chord keyed generation 不够。

恢复顺序：

```text
确认写入所有权
→ 打开 Session
→ 读取未完成 operation 与 durable command
→ 恢复准确插件 generation / 配置
→ 对账外部执行记录
→ 按策略 drive / 等待人工确认 / 标记中断
→ 重建投影并接受客户端订阅
```

### 5.6 副作用的恢复策略

| 工作 | 默认恢复行为 |
| --- | --- |
| 已完成且结果持久化的工具 | 返回原结果，绝不再次执行 |
| 无外部写副作用的读工具 | 经工具定义与策略批准后允许安全重放；需要相同读结果时固定 workspace revision |
| 支持 idempotency key 的外部 API | 用稳定 invocation ID 对账 / 重试 |
| 修改文件 | 根据旧内容 hash、目标内容 hash、patch receipt 判断已执行 / 未执行 / 冲突 |
| 任意 shell / deploy / payment 等 | 默认不自动重跑；无法确定结果时明确标记 `outcome_unknown` |
| 中断的普通模型流 | 展示已提交 partial 和中断状态；重新请求是新尝试，不能声称继续原 TCP / HTTP 流 |
| Provider 支持的 deferred 请求 | 仅在 provider 语义明确且 handle 有效时恢复查询 |
| 待用户问题 / 审批 | 从持久记录重建，不依赖旧 Promise 或旧对话框 |

core 当前对 orphan assistant 的恢复会从已提交 frame 构造中断消息，而不是自动发起同一请求；不安全工具也会被标记中断。omo 应保留这种保守语义，而非为了“无缝”盲目重试。

### 5.7 配置、压缩与历史

- 每次运行记录 model identity、有效资源版本、工具 schema hash、插件 generation、workspace revision 和 policy revision。
- 凭据只记录引用，不能把 API key、OAuth token 或敏感 headers 放进运行快照。
- core 的全局 tools / resources 等运行配置需要 omo 重新装配；不能假设它们全部由 Session 自动持久化。
- 压缩作为可追踪操作，保留摘要来源、用量、retained tail 与版本；不删除原始历史来冒充上下文压缩。
- UI 裁剪、模型上下文压缩、历史归档是三种不同操作。
- 搜索和历史读取使用分页 / 索引，列表页不加载每个 Session 的 Harness。

### 5.8 掉电零丢失：持久确认的硬契约

**原则：已确认操作的 RPO=0。** 这不是“尽量缩短最后几秒丢失窗口”，不能通过 UI 文案掩盖先回包、后刷盘。确认受理与确认完成是两种不同事实，两者各自必须可在重启后查到。

| 对象 / 回执 | 确认前必须成立 |
| --- | --- |
| `queued` / `admitted` | 命令 payload、去重键、稳定执行身份及所依赖附件均可可靠恢复 |
| Prompt、steer、follow-up、取消意图 | 已在权威记录中落盘；取消受理不等于外部进程已停止 |
| Interaction 答案、插件启用 / 配置变更 | 答案或 desired generation、版本、权限及必要产物先持久化；实际生效状态单独发布 |
| 工具 / Run 的 `completed` | 执行结果与必要 artifact 已落盘，完成回执可查询，不会重启后重新变成未执行 |
| 编辑器“已保存” | 目标文件内容和替换的持久性已保证，revision / hash 与保存 receipt 可对账；不是仅把文本写进请求日志 |
| 已提交历史 / token frame | 权威提交完成后才对客户端作为 durable 数据发布；不从遥测或内存缓存恢复 |

存储基线：

1. **SQLite 采用本地 WAL + `synchronous=FULL`**，覆盖 omo 控制库和执行库的所有写连接；启动时设置并读回检查，不依赖驱动默认值。`NORMAL` 不能满足本目标；WAL 下 `EXTRA` 不比 `FULL` 提供额外保证，若改用 rollback journal 则重新验证，不能照搬配置。
2. `Storage.commit()`、命令事务及 outbox 确认必须等到所需同步写成功才 resolve / 回包。group commit 允许合并事务等待，不允许先确认再异步刷盘。磁盘满、I/O / sync 失败时停止受理相关写操作，不能静默降级为内存队列或 `NORMAL`。
3. 新建数据库、artifact、插件 generation 和文件保存也要有掉电协议：先写临时内容并同步，再执行平台支持的原子替换 / 发布，保证必要目录元数据持久化，最后提交引用 / 回执。孤儿文件可 GC，但不能出现持久记录引用一个尚未可靠落盘的文件。
4. 文件保存采用旧 hash / revision 前置条件、稳定 mutation ID、目标 hash 和恢复对账。文件替换与数据库 receipt 不假装是一个事务；在二者之间崩溃时根据实际内容判断已应用、未应用或冲突。
5. 分别验证 Linux 文件 / 目录同步、Windows 刷盘与替换语义、macOS SQLite `fullfsync` / `F_FULLFSYNC` 路径。不能仅因为 JS `fsync` 返回就声称所有 OS、文件系统和磁盘组合已获验证。
6. 启动检查存储模式与权限，报告有效 durability 配置；不支持可靠同步的网络盘 / 容器卷配置不能宣称达标。Node / Bun 性能测试使用相同可靠性设置。

**终端和外部世界的边界不能混淆：** PTY echo 不表示命令已持久受理或副作用已完成。如果终端输入提供 durable receipt，必须先记录输入意图，崩溃后结果未知则标记 `outcome_unknown`，绝不自动重放 shell 字节。出于密码等敏感信息保护而不记录的字符流只能是明确的实时交互通道，不得返回持久确认。普通 shell 对任意文件的写入、远端部署和模型计费不自动获得 omo 文件保存 API 的原子性。

单台 daemon 可在正确兑现 flush 的本地存储上实现掉电 RPO=0，但不能保证磁盘物理损毁、固件虚报写入完成或整机永久丢失时仍不丢数据；这需要可靠硬件、备份，甚至独立故障域的同步副本，不能由一个 SQLite pragma 解决。UPS / 带掉电保护的 SSD 可降低风险，但不代替提交协议。

验证时由独立客户端 / 测试控制机记录**实际收到的回执集合**，在受理、文件替换、artifact 发布和结果提交各边界注入进程退出、OS 重置及可控断电，重启后逐项对账。`kill -9` 不会清空 OS 页缓存，不能替代掉电测试；虚拟机断电也必须核验宿主缓存配置，最终支持声明需有对应硬件 / 存储栈证据。

## 6. 多端同步协议

### 6.1 共享什么，不共享什么

| 数据 | 同步策略 |
| --- | --- |
| 会话历史、运行状态、队列、工具结果、审批、插件状态 | 执行端权威，多端订阅 |
| 项目 / 会话名称、模型设置、共享评论 | 服务端排序，revision / CAS 防覆盖 |
| 个人输入草稿 | 在线时用户级版本化保存；按设备保留分支；离线可保留未发送文本，不自动提交为 Prompt |
| 当前选中会话、滚动位置、折叠状态 | 默认设备本地；“跟随另一设备”是显式功能 |
| 在线设备、正在查看、输入提示 | 短期 presence，有 TTL，不写逐次审计日志 |
| 文件、Git worktree、终端进程 | 属于执行端；提供操作、摘要和 artifact，不等于文件系统自动复制 |
| Provider 凭据 | 仅执行侧保管；客户端只看授权后的非敏感状态 |

### 6.2 传输选择

建议第一版：

- HTTPS：登录 / 配对、command、query、历史分页、artifact 上传下载。
- 单条 WSS 控制 / 订阅连接：多个 Session、任务与交互的多路复用。
- 终端与大流量输出使用独立流或单独有预算的连接，避免堵塞取消、审批等控制消息。
- SSE 可作为只读降级方式，但与 WebSocket 共用事件与恢复语义。

Chord RemoteServiceTransport 可作为内部和 JS 客户端的适配边界，但 **omo 拥有外层 framing、认证、路由、重连、背压与协议版本**。

不默认采用 Pi 实验协议作为公开移动端 API：当前 `pi-server` / `pi-protocol` 可研究复用，但 Unix transport 不自带应用鉴权，且实验设计与单选 Session 假设不能限制 omo 的多窗格、多会话需求。

### 6.3 协议身份与序号分层

拟议外层字段包括：

```text
protocolVersion
serverId / workspaceId / sessionId / laneId
subscriptionId / bindingEpoch
requestId 或 commandId
payloadSchemaVersion
cursor 或 publicationSequence
payload
```

- `serverId` 是持久逻辑身份，不是 URL；更换地址不产生一个新会话身份。
- `requestId` 是一次传输调用，`commandId` 是跨重连的业务操作，二者不能混用。
- 存储 commit sequence、omo 重放 cursor、Chord state sequence 分属不同域，不要求数值相等。
- Chord 路径字典与 state codec 按订阅 / state member 独立；断线、替换或重新 hydration 后重建，不能跨订阅共享。
- 需要跨语言传递的大整数 cursor 使用十进制字符串或明确安全整数上限；时间统一格式，不能依赖 JS 的 `Date` / `BigInt` 序列化。
- 协议由运行时 schema 校验，不只共享 TypeScript interface。未知非关键 UI block 可降级，未知控制指令必须拒绝。

### 6.4 快照与增量的无缝边界

订阅必须形成可测试的顺序：

1. 安装更新捕获 / 建立读快照边界。
2. 得到状态快照与一致水位 `C`。
3. 发送快照，随后补发 `C` 之后的更新。
4. 客户端应用成功后再推进 `appliedCursor`；持久缓存和 cursor 一起提交。
5. 若 cursor 过期、epoch 改变、codec 失配或发现缺口，停止追加，返回 `reset_required` 并重新获取快照。

过滤后的 lane 订阅不能把跳过的其他 lane 存储 seq 当成丢包；应使用订阅自己的连续 publication sequence，或携带显式扫描水位。

**首版允许重连直接 fresh snapshot + 按需历史分页。** 重放是优化，不应成为唯一恢复办法，也不需要永远保留所有 token delta。

### 6.5 持久边界与实时体验

分开两条数据路径：

- **持久控制 / 结果**：命令受理、用户消息、工具执行意图与结果、交互答案、最终消息；先提交再确认。
- **实时进度**：文本 / thinking frame、工具日志和进度。可以有明确标识的低延迟预览，但不能把未提交内容的 cursor 当作持久确认。

首版只推已可靠提交的进度，避免把用户已看到的内容误解为可丢弃尾部。未来如增加 provisional 预览，必须另行评审并显式标识 `durableThrough` 与未保存状态，重启后以持久快照替换该尾部；不能借此放宽已确认操作 RPO=0。

存储 group commit 不得提前 resolve `Storage.commit()`；否则工具可能在执行意图真正落盘前发生副作用。合批需保持顺序、返回 seq 和失败传播语义。

### 6.6 并发操作规则

- 两端同时提交 Prompt：服务端确定顺序；默认后到的进入持久 follow-up 队列，返回可查看的排队位置 / 状态。
- 两端同时回答同一 Interaction：数据库事务只接受一个答案，其余返回已完成状态。
- 修改模型或工具集：作用于明确的下一次运行 / 下一模型轮次，不改变已经发出的模型请求 schema。
- 导航 / 分支：必须绑定 base revision；运行中不允许另一客户端偷偷改变该 lane 的 tip。
- 取消：绑定 `expectedOperationId`，旧 UI 发出的取消不能终止后来的新 Run。
- 多端终端：可以多人观看；输入和 resize 默认由一个可转交的控制权持有者操作，避免字符与尺寸互相干扰。

会话执行不采用 CRDT。若以后需要共享草稿、画布或编辑器，CRDT 仅作用于那些协作文档，不延伸到 shell、工具和 Agent loop。

### 6.7 移动端：React Native 优先，鸿蒙是正式目标

**建议采用 React Native + React Native OpenHarmony（RNOH），共享业务和组件契约；不重写现有 Web / Electron 为 React Native。** RN 官方把 OpenHarmony 列为合作方维护的 out-of-tree 平台，这证明有适配路线，不代表 upstream RN 的所有版本、原生模块和鸿蒙设备自动兼容。

- iOS / Android 使用通过矩阵的 RN 版本；鸿蒙使用与之可兼容的 RNOH 发行版及平台适配层。先核对 RN、React、Hermes / 新架构、RNOH 和原生模块的版本交集，不要求它们与现有 Web React 19 共用同一个运行时版本。
- “支持鸿蒙”需在指定 HarmonyOS / OpenHarmony 真机上构建和验收；安装 Android APK 兼容版不算完成原生鸿蒙目标。HarmonyOS NEXT 与 OpenHarmony 的发行版、API 和设备支持分别记录，不能混为一项已验证能力。
- 若 RNOH 某个桥接能力缺失，局部补 ArkTS / 原生 adapter 或 WebSurface 桥接；不能默默删除鸿蒙目标，也不预设重新写整套 ArkUI 产品。P2 先做小闭环，确认路线后投入正式移动 UI。
- 以 OpenAPI / JSON Schema、状态机、TS SDK 和 golden wire fixtures 为公开契约；移动端不需要运行 Chord 的 Node loader 或 Harness。

#### 共享边界

| 层 | 复用方式 |
| --- | --- |
| protocol / client / domain | 共享纯 TS schema、命令、同步 reducer、重连、revision / CAS 和业务模型；不依赖 DOM / Node |
| 会话与插件 view model | 共享有界节点 DTO、事件归并、分页与 Interaction 状态，不共享上游内部对象 |
| 原生 UI | RN 视图与导航、触摸 / 键盘 / 无障碍适配；声明式插件组件映射到原生组件 |
| Web UI / 重型表面 | 现有 shadcn / Base UI、DOM 终端与编辑器继续属于 Web；可在受控 WebSurface 中复用，不当作 RN 原生组件直接 import |
| 平台 adapter | 安全存储、推送、文件选择 / 分享、后台生命周期、WebView / ArkWeb 和输入法分别实现 |

不承诺统一框架等于 100% UI 代码复用，也不预估未测的复用百分比。客户端只执行展示与输入逻辑，代码工具、PTY、Git 和实际文件写入仍在 daemon 所在电脑。

#### 移动端首版功能矩阵

| 功能 | 实现建议与验收边界 |
| --- | --- |
| 会话 | 列表 / 历史分页、流式消息、工具状态、发送 / steer / follow-up / 取消、Interaction、插件节点；与桌面读取同一权威状态 |
| 终端 | 真正连接 daemon PTY，支持输入、控制键、复制粘贴、resize、输入权转交和断线恢复；优先验证 WebSurface 复用现有终端，不能用静态日志列表替代 |
| 文件 | 文件树、搜索、文本打开 / 编辑 / 保存、变更 / diff；保存带 base revision / hash，桌面并发修改返回冲突，不静默覆盖 |
| 编辑体验 | 先用可复用 Web 编辑面验证，再决定原生优化；中文 IME、软键盘、选择 / 光标、硬件键盘、大文件限额和低内存是发布门槛 |
| 插件 | 声明式组件全端一致；复杂 web facet 可进受控 WebSurface，或提供原生 / 只读 fallback；未知 schema 不导致整段会话失效 |
| 生命周期 | 后台挂起后断开属正常；前台重新鉴权、取快照并校准终端 / 文件 revision；daemon 离线则所有相关内容不可访问 |

APNs、FCM 及鸿蒙对应推送采用平台 adapter，只发最少的任务提示，不携带源码、正文或密钥；自托管 daemon 不可达时通知不构成仍在线的证明。推送并非维持执行的必要条件，也不把云服务引入 Session 权威链。

WebSurface 只能通过受限 bridge 获得当前会话 / artifact / 终端能力，不拿长期 daemon token、原生文件系统或任意导航权限。动态代码加载与应用商店规则必须按发行渠道核对；不允许动态执行 JS 的渠道使用随包 renderer + 声明式数据，不能依赖线上下载任意 RN bundle 过审。

## 7. 插件系统与热重载

目标已明确：**用户 / Agent 在受信任环境中生成插件，omo 提供组件和 skill 教程，使插件能贡献会话 UI、工具与交互，并在不重启整个应用的前提下启用 / 更新。** 不做第三方市场，也不承诺 Pi 扩展 API 兼容。

### 7.0 DeepSeek Harness「UI 插件」对照

已阅读用户指定的 [扩展 cookbook · UI 插件](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/extension-cookbook#ui-插件)，并沿链接核对 Conversation、Slots、Client 模块和设置卡片文档。源码文档固定到 `deepseek-ai/deepseek-harness@c291e7961a515f6d7af9304e7fd1d257929aef26`；下表是文档核验，不是本次运行过 DeepSeek 的测试结论。

| DeepSeek 文档中的机制 | omo 应借鉴的契约 | 不直接照搬的部分 |
| --- | --- | --- |
| 持久 `session/event` settlement / 边界 / 工具活动 + 瞬态 `agent/assistant-stream` | 持久事实与实时呈现分离，历史重放与实时追加得到相同最终视图 | 不把 chunk 本身当完整历史；omo 首版只发布已可靠提交进度 |
| `followup()` / `steer()` 将输入送回 Agent | UI 发出显式 follow-up / steer 等命令，执行状态独立订阅 | 浏览器不直接拿 Agent handle；命令经过 omo 身份、幂等、持久受理层 |
| `ConversationNodeDefinition` + keyed Chat renderer | 业务事件 → 按稳定 ID 组装 view model → 按 node kind 渲染；UI 插件可添加业务行 | 不绑定 DeepSeek 数据格式，不让 renderer 自己遍历整个 Session 日志 |
| 类型化 Slots、scope、list / keyed 等 cardinality、effect 生命周期 | 宿主声明插槽，插件声明贡献与清理；向组件注入受限数据 / 动作 | 不改用 Cordis；Chord 不自带这套 React Slots，omo 需要实现轻量注册表 |
| host / browser 两半、版本化 client bundle、无需重建 Web 应用 | 插件产物与主应用解耦；客户端按精确 generation 取 UI 产物 | 不复制其 lazy-CJS boot 协议；Web、RN、Node 的产物分别处理 |
| 开发环境 HMR；Client 模块文档明确生产图不含 HMR 行 | 借鉴注册清理和产物变更通知 | omo 的生产热激活、旧调用 drain、崩溃恢复和掉电提交需自己实现，不能由 HMR 推导出来 |

尤其要借鉴其 **Conversation assembly 与 renderer 解耦**：同一业务实体通过 `(kind, id)` 关联 start / update；尾部历史只有 update 时保持 pending，补齐 start 后确定性回放；高频更新只合并视图发布，不跳过状态归并。未知节点可 fallback，而不是加载某个插件失败就丢掉会话历史。

DeepSeek 设置卡片教程也记录了跨功能插件不能直接导入运行时组件、仓库外作者需自行复刻 bundle 格式等限制。omo 应补上**公开的共享 UI 包、作者构建预设和可执行教程**，避免 Agent 每次重造控件、加载器和表单模型。

### 7.1 插件不是一份在所有地方执行的 JS

一个插件可以包含以下独立部分：

| 部分 | 运行位置 | 作用 |
| --- | --- | --- |
| contract / manifest | 构建与校验时 | schema、兼容版本、声明能力、产物 hash、插槽与节点贡献 |
| runtime facet | Runtime / Plugin Host | 工具、钩子、资源、后台能力；UI-only 插件可不含此部分 |
| presentation / node definition | 客户端展示层 | 按稳定实体 ID 折叠业务事件，产生可重放、与 target 解耦的 view model |
| declarative UI contribution | 各客户端宿主 renderer | 使用 omo 内置组件显示表单、状态、结果与动作，默认全端可用 |
| 可选 web facet | 可销毁的隔离 iframe / WebSurface | 自定义 React UI，使用公开组件包；首版即验证该路径，不依赖主应用重建 |
| 可选 native integration | 随客户端版本分发 | 原生能力由宿主提供；不能由热下载服务端代码冒充原生二进制插件 |

底层复用 Chord facet，但公开插件 SDK 使用 omo 自有包和版本，不将 raw Session、Storage、Harness 或凭据直接暴露给普通插件。

### 7.2 拟议 manifest 内容

manifest 是 omo 待设计规范，不是 Chord 现有格式的完整描述。

至少包含：

- 稳定 plugin ID、版本、SDK / protocol 兼容范围。
- 各 facet 入口、支持客户端、UI schema 版本、所需 slot / node kind、fallback 与宿主组件版本。
- 请求的 filesystem / network / process / provider / session 能力。
- 状态 schema 版本、迁移策略、工具 schema hash。
- CPU / 内存 / 时限 / 并发 / 输出预算。
- 源码、依赖锁、构建产物的完整性 hash 和来源。

Chord 已有 `chord.facets` 构建入口约定；omo 可在其上增加产品元数据，不重复发明底层 bundle 格式。Node bundler 输出 `.cjs` 不可直接拿去给浏览器 / 手机运行。

### 7.3 从生成到启用

```text
用户请求 / Agent 提案
→ 在 staging workspace 生成源码、manifest、测试
→ 依赖解析与锁定（默认禁用 lifecycle scripts）
→ 类型 / schema / 权限 / 静态检查
→ 隔离构建与测试
→ 展示 diff、来源、权限增量和资源预算
→ 用户批准或匹配明确的预授权策略
→ 生成不可变 artifact
→ 装载候选 generation，健康检查
→ 等待受影响调用安全点
→ 切换 contribution registry
→ 各客户端刷新能力目录与 UI
→ 退休旧 generation、清理资源、记录审计
```

可信模式允许用户对指定项目 / 插件目录预授权，Agent 在既有权限内可自动生成、校验与激活，**无需每次编辑都人工批准**。首次信任或权限扩大仍由用户 / 外部宿主策略决定；生成权限不等于自行扩大权限，插件不能靠修改 manifest、测试或审批 UI 获得授权。构建依赖与安装脚本仍可能产生意外副作用，默认限制 lifecycle scripts、网络和时限；不引入市场审核、发布者认证或付费分发流程。

建议提供由宿主管理的 `plugin.propose`、`plugin.validate`、`plugin.activate`、`plugin.reload` 等命令 / 工具；以上名称为拟议 API。插件管理器位于被替换宿主之外，不能让插件同步等待自己的卸载完成造成死锁。

### 7.4 Chord reload 的正确使用方式

**A. 同形更新**：facet ID、依赖与服务成员不变，仅实现改变。

- 加载候选 `LoadedFacets`。
- 在 omo 的调用屏障后使用 `FacetHost.reload()`。
- 验证 / 激活失败且候选清理成功时保留旧版本；失败候选必须 dispose。
- 切换成功后再释放 retired `LoadedFacets`。
- 切换或清理发生严重失败时，将受影响宿主标记故障并重建；不承诺万能回滚。

**B. 动态增删工具 / 命令 / UI contribution**：

- 工具定义作为宿主管理的 contribution 数据，不为每个工具创建一个必须改变 Chord 图的服务成员。
- 插件对稳定的 registry / capability broker 提交贡献；宿主构造新注册表，再在安全边界应用。
- 注册表按 plugin ID + generation 管理，重建时确定性排序、检查重复工具名和 schema，不靠“撤销旧代码的副作用”恢复。

**C. 结构变化**：新插件、新依赖、新服务形状。

- 使用独立 plugin capsule / 新 FacetHost 构建候选图，不能对现有 host 直接调用 reload 增加未知 facet。
- 通过宿主外的稳定 broker 接入，限制重建范围。
- 影响 Session 所有权的更新需要停止旧 Runtime Host 并完成恢复，不承诺无路由间隙。

跨插件依赖通过声明的服务和宿主调解，不导入另一个插件的活实例。首版不追求任意图的局部事务替换。

### 7.5 运行中的任务如何处理版本

**默认在下一模型轮次的安全点生效；当前轮次继续使用已捕获的工具集合。**

- 已发出的模型请求及对应工具批次固定 `toolsetRevision`、插件 generation、schema hash。
- 工具运行中不销毁其宿主，不在原函数执行到一半时替换闭包。
- 旧调用完成并落盘后再释放版本引用；热替换等待时间和真正切换时间分别展示。
- 长时间等待用户的操作以持久 Interaction 重建；需要旧代码恢复时，保留可重新加载的旧产物，而不是永久保留旧进程。
- 没有可信迁移方式时保持旧 generation，或明确中止并确认后重试；不能把旧参数交给任意新实现。
- 为 draining 设置时限和资源上限；超时提供继续等待、显式取消或重启该隔离宿主。

Chord 不自动替 omo 提供这套 drain / pin 机制。不能因为稳定服务句柄还存在，就假定旧调用的依赖句柄在退休后仍可用。

### 7.6 持久状态与跨端交互

插件持久状态放在受限 namespace 中，声明 `global / workspace / session / lane / invocation` scope 和 schema 版本。fork 时明确哪些复制、哪些清空，不能把待执行任务和账单随历史复制一遍。

审批 / 问题采用持久 Interaction：

```text
interactionId + invocationId + pluginGeneration
schemaVersion + request + status + revision
eligiblePrincipals + deadline + answer（可选）
```

- 请求先持久化，再生成 Chord keyed service / omo 实时投影。
- 所有授权客户端看到同一待办；客户端断开不会默认取消。
- 答案在一个事务中比较状态、校验权限和版本，只接受一次，然后唤醒对应任务。
- 重启后由持久记录重新生成服务实例；keyed generation 可以变化，interaction ID 不变。
- SDK memo 可辅助恢复，但不能用 `getMemo()` 后 `setMemo()` 冒充并发安全的原子抢答。

声明式 UI 首版覆盖：选择、输入、确认、表单、Markdown、状态、表格、diff / artifact 引用、动作。它是有界组件协议，不是任意 JSX / HTML 执行器。未知组件提供只读降级，权限确认由可信宿主 UI 展示。

Web / Electron 继续遵守 shadcn、Base UI 和语义化颜色约定；原生客户端映射到原生控件，不要求复刻 TUI 组件。可复用组件包与 skill 教程是正式交付物，详见 7.10–7.11。

会话节点标识至少包含 plugin ID、node kind、稳定 entity ID 与 payload schema version；持久事件还记录来源 generation。live 追加、历史分页 / prepend、完整 replay 必须得到一致的最终 view model。最终 settlement 替换 / 校准相同实体的流式状态，不能再次拼接形成重复正文。每个业务事实只有一个持久 owner，插件命名空间不能再维护一份独立可写 transcript。

UI renderer 的版本可以与后台正在 drain 的 generation 不同，但必须声明能读取的 payload 版本；不兼容时保留旧 renderer 或使用持久的文本 / artifact fallback，不能把旧数据交给任意新 JSX。UI 刷新不意味着后端已换代，后端切换也不要求所有客户端同时在线。

### 7.7 可信插件的故障隔离，而非市场沙箱平台

| 代码 | 建议模式 | 首版责任 |
| --- | --- | --- |
| omo 内置、维护的代码 | Runtime / 客户端内的共享组件或受控 worker | 清晰生命周期、测试与性能 |
| 用户 / Agent 生成的可信后台插件 | 可监督、可替换的 Plugin Host + capability broker | 隔离崩溃、退出和资源失控；不注入控制面 / Electron 主进程 |
| 用户 / Agent 生成的可信 Web UI | 声明式宿主组件或隔离 iframe / WebSurface | 清理订阅、异常 fallback、限制 bridge、不暴露 daemon 密钥 |
| 第三方恶意代码 / 插件市场 | 不在产品范围 | 不建设审核系统、签名信任网络或通用强沙箱 |

“可信”是用户授权执行的信任假设，不表示 Agent 生成的代码没有死循环、误删或依赖风险。因此仍保留预算、审计、外部宿主控制的权限增量与可回收进程；允许在明确的预授权范围内自动激活。

- `node:vm`、Worker、普通子进程和 TypeScript 类型不是恶意代码安全边界；同权限进程仍可绕过 broker 访问文件 / 网络。没有 OS 强制隔离时必须如实标注。
- 任意 shell 是强权限；workspace guard 能保护 omo 的路径 API，不能限制任意 shell 的全部副作用。
- 三平台首版交付可信插件 + 故障隔离，不以三套同等级容器 / VM 沙箱作为发布前提；可用的 OS 资源限制仍应启用。
- hash 用于产物完整性和精确恢复，不假装是信任证明。来源和授权记录留在本机即可，无需市场发布者签名基础设施。

### 7.8 回滚与资源回收

- 激活记录使用 desired / active generation 和状态机；数据库与内存路由不能原子提交时，重启按持久意图对账。
- 候选阶段禁止不可逆业务副作用，健康检查使用 dry-run capability。
- 回滚只承诺恢复可兼容旧代码 / 配置，不自动撤销文件、外部 API 或模型费用。
- 数据迁移采用版本化和 expand / contract；不兼容时先备份并停止受影响操作，不能切回旧指针就算完成。
- 必须清理 timer、listener、watcher、socket、子进程、UI 容器和订阅。
- Node CJS 分代加载释放引用后只是“可被 GC”，非立即释放内存。
- Web 动态 ESM 的模块缓存不会因卸载组件消失；自定义 UI generation 首版就验证可销毁 iframe / WebSurface 路径。按插件 generation 共享容器、按视口挂载展示，不能一条会话消息创建一个永久 iframe；相关内存和消息桥接成本进入基准。

### 7.9 不做 Pi 扩展兼容层

不实现 `ctx.ui`、TUI Component、Pi extension events 或 raw SessionManager 的 shim，不维护 legacy 插件执行模式。Agent 可以读取旧插件源码，依据 omo SDK 和教程改写并运行测试；这是源码迁移，不是兼容承诺。

`SKILL.md`、AGENTS 上下文和纯文本提示资源可以复用，但路径、信任与版本由 omo 管理。v1 JSONL 数据导入是独立的数据迁移需求，不因为取消插件兼容而取消，也不能因此执行导入数据中的旧代码。

### 7.10 omo 提供的 UI 插件 SDK

以下包名与 API 角色均为**拟议交付物，当前仓库尚未实现或发布**：

| 交付物 | 作者可复用的能力 |
| --- | --- |
| `@omo/plugin-sdk` | manifest、runtime / UI contribution、能力 client、scope、dispose、版本化事件与测试契约 |
| `@omo/plugin-ui` | Web React 组件、宿主主题、表单校验、加载 / 错误 / 空态、受限动作；复用现有 shadcn / Base UI |
| `@omo/plugin-ui-schema` | 跨端组件和动作 schema、节点 DTO、版本校验与文本 / artifact fallback |
| `@omo/plugin-ui-native` | 移动阶段提供对应 RN renderer 与鸿蒙适配，不把 DOM 控件导出给 RN |
| 构建预设与 test kit | 浏览器 / 后台分产物、共享依赖约束、mock host、事件 replay、slot / cleanup 和多端 fixtures |
| 作者目录 / inspect 工具 | 当前可用 slot、node kind、组件 props、能力、主题 token、SDK 版本、示例和诊断；同时向人和 Agent 提供 |

共享组件分两层：基础控件（Button / Input / Select / Card / Table / Dialog 等）与业务组件（消息内容、工具调用 / 结果、进度、Interaction 表单、artifact 链接、文件 / diff 预览）。优先抽取现有展示能力，不为接入某个 UI 库更换 Agent 或整个会话滚动实现。Web 自定义 trigger 继续使用 Base UI `render`，颜色只能来自宿主语义 token。

首批拟议插槽只保留明确需求，避免把整个 React 树变成开放插件图：

| 插槽 | 类型 / scope | 用途 |
| --- | --- | --- |
| `conversation.node` | keyed / session | 按 node kind 渲染业务行或工具结果 |
| `conversation.header.actions` | list / session | 会话动作 |
| `composer.actions` | list / session | 向当前会话提交明确命令，不接管编辑器内部状态 |
| `workspace.panel` | list / workspace | 项目面板 / 任务视图 |
| `settings.plugin` | keyed / plugin | 带 revision 的插件配置表单 |

宿主拥有插槽声明与输入类型，贡献以 `pluginId + contributionId + generation` 注册，稳定业务 key 不随热更新改变。重复 key、未知 scope、组件 / schema 版本不兼容在激活时拒绝；贡献清理跟随 generation，不能留下重复按钮与监听器。

```text
插件后台 / 工具 → 权威业务事件 / 状态（先持久提交）
                → omo query / subscription
                → 节点定义：稳定 ID + 增量 reducer
                → target-neutral view model
                → keyed renderer / 声明式组件 / WebSurface
用户动作        → 类型化 command client → durable receipt
```

组件只收到当前 scope 的数据、稳定 selector 和受限 action，不拿 raw Chord host、Session、全局 token、`window.omo` 或可直接修改的业务 store。跨 iframe / WebSurface 传 JSON DTO 和 action ID，通过校验过的 bridge 调用，不试图传 React element、函数闭包或对象活引用。

插件静态资源由已鉴权的 daemon 按精确 hash / generation 提供，无需重新打包主 Web 客户端。长期缓存只保证取回同一字节，不允许离线打开该 daemon 的会话；禁用 / 撤权后停止能力调用。UI 无法加载时显示宿主 fallback 和诊断，不阻断历史、输入或取消。

### 7.11 Skill 教程与 Agent 自生成闭环

教程不是一页概念介绍，而是随 SDK 版本发布、可直接验证的作者工具链；不建立第三方插件商店。建议提供 `omo-plugin-authoring/SKILL.md` 及按需引用的短文档、模板和测试 fixture：

1. **发现能力**：先读取 daemon 的 SDK / slot / component catalog，确认目标是 UI-only、工具 + UI、面板还是 Interaction，不修改应用源码寻找私有入口。
2. **生成最小包**：使用官方 scaffold，声明目标端、scope、权限、事件 / 状态版本；复用组件包，默认提供声明式或只读 fallback。
3. **实现可回放节点**：按稳定 ID 生成 start / update / terminal 事实，完成 reducer 与 renderer；证明实时追加、重连、历史 prepend 的结果一致。
4. **提交动作**：用宿主 command client，处理 durable receipt、revision 冲突、重复点击、会话切换和 offline；不直接调用 Agent / 文件系统。
5. **本地验证与预览**：类型 / schema / 权限、模拟事件、主题 / 键盘、未知组件、dispose 和目标端检查；输出构建产物 hash 与差异。
6. **受信任热激活**：在用户预授权范围内自动 activate；权限扩大则由宿主询问用户。展示 desired / active generation、等待安全点的状态及失败诊断。
7. **更新与恢复**：故意制造旧版本在途调用、渲染异常、重复订阅、断线与 Worker 重启，证明旧数据可读、旧调用不串代、失败可回退。

配套至少提供四个端到端示例：UI-only 项目状态面板；工具 + 可回放进度卡片；配置表单 + CAS 保存；持久 Interaction + 多端一次回答。每个示例同时有“用户需求 → Agent 生成 → 检查 → 激活 → 修改 → 恢复”的脚本和验收断言。

教程中的命令、组件 props 和 schema 必须来自同一份 SDK 类型 / catalog，并在 CI 中运行，避免文档 API 与包版本漂移。Agent 改写 Pi 或其他系统插件时也走这条路径，不为旧接口新增兼容分支。

## 8. 高并发与资源预算

### 8.1 容量口径：100 个真实运行的会话进程

按用户的“会话进程”要求，验收采用 **100 个独立 OS 进程，每个拥有不同的根 Session 和至少一个正在推进的 operation**，分布于多个项目。它们可以等待模型网络或工具 I/O，但不能只启动后空闲、统一排队、等待用户答题，或把 100 个任务标签贴在少量执行进程上。

Supervisor 同时公布 `residentSessionWorkers`、`runningSessions`、`queuedSessions`、`waitingForProvider`、`waitingForInteraction`、`activeModelRequests`、`activeToolProcesses`；指标不能互相替代。采集 PID / 实例 token、operation ID、阶段变化、提交和完成吞吐，证明每个进程持续推进，而非只存活。

最低容量 workload：

| 场景 | 同时运行内容 | 用途 |
| --- | --- | --- |
| A：模型路径 | 20 个项目 × 5 个 Worker，各自运行独立 faux 模型脚本，共 100 个会话进程 | 可重复控制流速、上下文和提交压力；不是一个进程开 100 个连接 |
| B：混合路径 | 100 个 Worker：50 个模型流、30 个外部 I/O 工具、10 个文件 / Git 查询、10 个插件任务 | 验证真实执行隔离、调度、IPC、输出和完整进程树成本 |
| C：CPU 压力 | 同样 100 个活跃会话，同时提交构建 / 测试，CPU 重任务按预算调度 | 证明控制面不饿死；不承诺普通电脑上 100 个编译器全速并行 |

A / B 先持续重叠运行至少 10 分钟，再进行 24h 混合长稳；排队压力另用 1000 个命令测试，不能替代 100 活跃进程验收。真实 Provider 配额不足应报告 `provider_limited`，不得把只有十几个请求获准的结果宣称为百会话能力证明。

内存预算按完整拓扑计算：`控制面 + 存储 / 共享宿主 + 100 × (Worker 基础开销 + 活跃上下文 + 有界输出) + 工具 / PTY + 客户端`。独立进程不能共享 JS 堆中的 Provider 实例和连接池；只加载所需 Provider，并通过共享服务协调凭据、索引、文件监听和插件，避免每个 Worker 复制一套控制面。

### 8.2 子 Agent 是逻辑任务，不递归创建新进程

- 同 Session 的可信子 Agent 优先使用 lane，复用该 Worker 内的 Provider 连接池、工具定义和只读资源；跨 Worker 共享能力走显式 broker，不假定对象能跨进程共享。
- 独立长期身份 / 权限 / 保留策略的子任务才创建独立 Session。
- 子 Agent 继承的是可授权的上下文快照和预算，不是全部凭据、工具和父 Agent 内存。
- 设置 `parentTaskId`、最大深度、最大扇出、累计任务数、token / 费用预算、总时限和取消传播规则。
- 父任务等待子任务时释放可运行槽位；不能占满所有 worker 槽再等待排队中的 children，造成调度死锁。
- 子任务结果返回摘要和 artifact 引用，避免把每个子 Agent 的完整 transcript 扩散给所有父任务与客户端。

### 8.3 分层限流与公平性

分别限制：

1. 用户 / workspace 的接受队列长度。
2. 活跃 Session / Lane 数和常驻上下文预算。
3. Provider / account / model 的请求数、RPM / TPM、retry 与费用预算。
4. 工具执行并发、shell 进程数、PTY 数、CPU 密集任务数。
5. Plugin Host 数、每 generation 的资源与 draining 数量。
6. 输出字节、artifact 容量、订阅数和每客户端发送缓冲。

采用公平队列与优先级，交互、审批、取消不能被后台 fan-out 饥饿。Retry 遵守 `Retry-After` 和抖动，不让嵌套重试层产生倍增请求；长等待以 durable `notBefore` 调度，不保留一个占槽的 sleep。

删除旧稿“每 workspace 16 个模型请求、8 个外部进程”作为容量依据的表述。拟议的百会话测试 profile：100 个活跃 Session Worker、faux Provider 至少 100 个可用请求许可、最多 64 个外部 I/O 工具进程、4 个 CPU 重任务、16 个 PTY；各项互相独立，实际默认值按机器和 Provider 配额校准。CPU / 外部工具的额度不是 Session Worker 总数上限。

workspace 使用带权公平份额与可借用的空闲额度，不能因固定小额上限让容量测试中的大部分会话永远等待。Plugin Host 按信任域 / generation 按需共享，禁止形成 `100 × 插件数` 个常驻宿主。达到 100 活跃会话后的新命令可排队 / 拒绝；不能通过把基准里的 100 个会话排成 10 个执行来“达标”。

### 8.4 进程、文件与终端

- 非交互工具使用管道，只有终端交互才创建 PTY。
- Process Supervisor 记录 task、pid、启动时间 / 实例 token、工作目录、退出码、输出位置和终止策略；不能仅凭 PID 防止 PID 重用问题。
- 取消逐级传播，优雅退出后超时强制终止整个进程树；分别验证 Unix process group 与 Windows Job Object 等平台机制。
- daemon / worker 重启后是否可附着原进程，取决于独立 supervisor / tmux 等具体实现；默认不承诺。
- 流输出保留有界 head / tail，完整输出按容量策略 spill 到 artifact；spool 也要限额和过期回收。
- 并行改代码优先独立 worktree；复用工作区时通过内容 hash、文件写队列或 patch 合并避免覆盖。
- Git checkout / reset 等 repository 级操作必须与其他任务协调；lane 隔离不等于文件系统隔离。

### 8.5 优先优化的数据热路径

1. 不持久化每个 token 对应的完整 `message_update.message`。
2. 优先使用 core / pi-ai 的紧凑 frame；不要保留上游可变 `partial` 引用作为历史快照。
3. 按 `contentIndex` / block ID 处理交错的 text、thinking、tool call，不能只“追加到最后一个块”。
4. 研究 20–50ms 或字节阈值的复制合批；写入合批以正确 durability 为前提，不能改成提前确认。
5. 数据库同步操作放在受控 Runtime / storage worker，不让磁盘阻塞控制面的鉴权、取消与心跳。
6. 懒加载 Provider SDK 与模型目录，避免每个 Agent 重复加载完整 provider 集合。
7. 空闲 Session 回收 Harness 与上下文；列表展示只读摘要。回收基于运行 / 等待 / 订阅 demand，不只看 UI 是否挂载。
8. UI 使用稳定的增量 store、结构共享、可见区渲染；后台会话仅保存有界尾部和状态，不持续解析 Markdown。
9. 大 diff、语法高亮、搜索与构建走按需 worker / 进程；不占用模型流处理线程。
10. 对慢客户端限制发送缓冲。可合并状态更新，但丢弃有依赖的 delta 后必须 rebase / resnapshot，不能静默跳过 append。

持久控制事件不可丢；遥测可以采样；实时展示可以降频。这三种背压策略必须分开。回收只针对空闲 / 可持久挂起的会话；100 个正在运行的 Worker 的基础内存必须如实计入，不能用卸载空闲上下文解释活跃成本。

### 8.6 100 进程与 FULL 提交的存储路径

P0 必须比较两条路线，不能先假设上游会自动合批：

- **A：每 Session 一个库，由对应 Worker 独占。** 最少自建代码，可先复用 `SqliteSessionRepo`；缺点是 100 组连接 / WAL / 同步写，不能跨数据库假装一次 fsync 覆盖全部提交。
- **B：少量 Storage Host，各自独占共享容器。** Worker 内保留唯一 Session / Harness，通过 core 异步 `Storage` 契约做类型化 IPC；Host 验证 Session / epoch，串行化写入，可探索同容器跨 Session group commit。候选收益是减少 fsync 放大，代价是 IPC、提交去重、故障面和 adapter 维护。

B 不是现成能力：`SqliteDatabaseFactory.transaction()` 要求同步 callback，不能直接透传 Promise。应在 `Storage` 层转译 Write / Value / Map 等数据，Context 只传 trace carrier，保留顺序、commit result、读写一致性与失败语义。底层是否能安全组合多个提交进一个事务、如何处理 IPC 回执丢失，必须单独验证并通过 Storage conformance；未通过就保留 A，不为优化破坏正确性。

控制库 inbox 与执行库仍遵守 5.4 的跨库对账。低频命令 / 完成确认和高频进度可有不同调度优先级，但所有承诺持久的数据都等 FULL 同步完成。P0 依据真实 fsync 延迟、100 个 Worker 的提交吞吐和恢复复杂度决定布局，Bun 不能成为掩盖这一瓶颈的替代答案。

## 9. Node 与 Bun 的选型计划

### 9.1 默认结论

**v2 首个正确性版本使用固定版本 Node；保留 Bun 运行通路，以数据决定是否成为默认。**

本地调研环境为 Node `v22.23.2`、Bun `1.4.0`，仅记录环境，不视为推荐版本。正式实现选择届时受支持且通过矩阵的版本，并固定锁文件 / 镜像。

理由：

- Agent 工作通常同时受模型延迟、限流、工具进程、上下文大小与 I/O 制约；HTTP hello-world 更快不代表 Agent 任务更快。
- Bun 可能改善启动、HTTP / WebSocket、SQLite 或部分内存占用，但必须验证真实 workload。
- Electron 内置 Node / Chromium，不能通过修改启动命令把 Electron 主进程替换成 Bun；可替换的是独立 daemon / Runtime Host。
- 若为 Bun 额外保留 Node PTY / plugin helper，必须计入完整进程树的资源与部署成本。

### 9.2 隔离运行时相关模块

通过窄适配器隔离 `HttpServer`、`SocketTransport`、`SessionStorageFactory`、`ProcessSupervisor`、`PtyBackend`、`FileWatcher`、`PluginLoader`。

core 产品模块不直接依赖 `Bun.*`；Node-only 插件 / SQLite 路径不直接流入 browser bundle。跨运行时并不要求所有第三方包都天然可移植。

### 9.3 必测兼容矩阵

| 范围 | 验证重点 |
| --- | --- |
| pi-ai Provider | TLS / proxy、SSE、WebSocket、abort、OAuth、流式 Unicode、工具参数、错误与 usage |
| core Harness | accept / drive / retry / compaction / safe replay / close / recovery 顺序 |
| Chord | `node:vm` generation loader、CommonJS / ESM externals、esbuild、GC 可回收性 |
| SQLite | `node:sqlite` 路径是否可用；`bun:sqlite` factory 的 no-create / readonly / transaction / WAL + FULL / fullfsync、回执时序、Storage conformance 与断电恢复 |
| 进程 / PTY | `node-pty`、信号、进程树回收、Windows、句柄泄漏、重连 |
| 文件系统 | rename、fs.watch、symlink、大小写路径、Unicode、磁盘错误 |
| 打包部署 | Linux / macOS / Windows、arm64 / x64、签名、升级、daemon 守护与崩溃转储 |

### 9.4 基准设计

同一业务实现、相同 Provider faux 脚本、相同 durability 设置与机器，分别测试 Node 与 Bun：

| 工作负载 | 观察 |
| --- | --- |
| 冷启动 / 首次 Prompt / 暖启动 | 到 ready、首个本地 frame 的时间，按需加载成本 |
| 1 / 10 / 100 个独立 Session Worker，执行 8.1 的 A / B workload | 全进程树 CPU、PSS / RSS、GC、event loop lag、frame / commit 延迟、每会话推进和完成率 |
| 1000 个排队命令，执行额度独立设为 100 | 排队公平性、内存、取消响应、完成率；仅为附加压力场景 |
| 10000 个历史 Session | 列表 / 搜索 / 首屏延迟，是否误加载全部上下文 |
| 同一会话多客户端，混入慢客户端 | 输出放大、背压、快照大小、重连正确性 |
| 连续 1000 次插件更新与失败回滚 | 旧模块、timer、listener、进程和内存是否累积 |
| shell 大输出、CPU 构建、父子任务 | 控制面响应与总进程树资源 |
| 24 小时混合负载 + 故障注入 | WAL / artifact / FD / 内存趋势与恢复正确率 |

微基准、Provider 网络时间、omo 自身开销分别报告。Node / Bun 均实际启动 100 个对应运行时的 Session Worker，固定相同项目、上下文、输出速率、存储布局、FULL 同步与插件集合，计入所有 helper / 工具进程；不能拿 Bun 单进程与 Node 百进程比较。faux 的独立任务使用独立脚本队列 / handle，避免并发消费顺序干扰结果。真实 Provider 仅做有限预算的兼容与抽样性能验证。

Bun 切换门槛建议：

- 所有正确性 / 安全 / 恢复测试通过，无关键平台阻塞。
- 在核心代表性负载上，吞吐或 CPU / 内存效率有持续、可复现的显著收益，例如 ≥20%，且关键 p95 无明显退化。
- 冷启动收益不能以热重载泄漏、取消失败或更弱持久性为代价。
- 如仅 Linux server 获益，允许 server 用 Bun、桌面 daemon 继续 Node，不为统一名字牺牲可靠性。

## 10. 安全、可观测性与运维

### 10.1 身份和凭据

首版可聚焦单用户多设备，但协议从一开始区分 user、device、workspace scope、role；不再把一个全局长期 Token 当作所有设备的唯一身份。

- 配对使用短期一次性 code / ticket，设备可独立撤销；服务端检查每条命令与订阅的权限。
- Desktop 使用 safeStorage / 系统 keychain，Mobile 使用 Keychain / Keystore。
- 同源 Web 优先 HttpOnly + Secure cookie / BFF，并处理 CSRF；跨服务器访问使用受控授权交换和短期 token，不复制长期管理密钥到 localStorage。
- WSS 验证 Origin、身份与授权，不仅依靠 CORS；ticket 绑定用途、设备 / session、时限与一次性消费。
- Provider CredentialStore 的 refresh 锁由一个权威服务串行化，或提供真正跨进程协调；不能每个 worker 各自刷新同一个 rotating token。
- 凭据、环境变量、headers 按请求授权注入，禁止修改全局 `process.env` 实现多用户切换。

### 10.2 Workspace 与网络边界

延续 v1 `OMO_WORKSPACE_ROOTS` 原则，并扩展到插件、工具、artifact 及新路径创建。除了 resolve / realpath，还需考虑新文件父目录、symlink race / TOCTOU；不可信执行最终靠 OS 隔离收敛。

插件网络权限、Provider base URL、浏览器代理、下载 / webhook 应有出站策略，防止 SSRF 访问控制面、内网凭据或云 metadata。secret 不进入 artifact、遥测、分享链接或通知 payload。

### 10.3 pi-telemetry 的使用方式

- 实现 omo adapter 到 OpenTelemetry 或有界本地日志；生产不长期使用无界 `InMemoryTelemetryContext`。
- 复用 core 的 `pi.ai.*` / `pi.harness.*` schema，补充 `omo.command.*`、`omo.sync.*`、`omo.plugin.*`、`omo.scheduler.*`。
- 本地调用显式传播 Context；跨进程只传允许的 trace carrier，在接收端重新创建上下文。
- 持久任务不保存 TelemetryContext / Span 对象；恢复后建立新的 trace / link，不试图恢复进程内 span。
- 记录 queue wait、执行时间、commit latency、输出吞吐、重连、reload 阶段、缓存、内存、FD / 进程数。
- ID 可以用于 trace 关联，但不把高基数 Session ID 作为 metrics label；默认不采集提示正文、思考内容、工具参数 / 输出和 secrets。
- Exporter 故障不得影响业务回调；通过 telemetry adapter conformance 验证，队列满时丢诊断不丢业务。
- 用户操作审计与遥测分开持久化，审计有明确保留和删除策略。

### 10.4 数据维护

- SQLite 定期 checkpoint、大小监控与一致备份；备份使用受支持的在线备份或停写流程，不只复制活跃主文件而遗漏 WAL。
- Artifact 以可达引用、任务 / 插件版本引用和保留期回收；先删除引用再延迟 GC，防止活跃任务产物被回收。
- 归档历史、流式进度、审计和遥测分别设 retention；长期 Session 不等于永久保存全部 token frame。
- 删除 Session / 用户数据须处理索引、artifact、缓存与备份保留政策，避免事件追加模式导致永远无法删除。
- 升级采用 schema 版本、迁移日志、备份和明确回退条件；插件旧 generation 与数据版本一起管理。

## 11. 初始验收指标

**100 个并发会话进程与已确认操作掉电 RPO=0 是确定要求；具体硬件、延迟和内存数字是待 P0 校准的预算，不是已测结果。** 百会话容量暂用 16 个逻辑 CPU / 32 GiB RAM / 本地 NVMe SSD 为参考档，Windows / macOS / Linux 分别记录实际设备与存储栈；这不是最低配置承诺。4 vCPU / 8 GiB 只做小容量与降级测试，不能沿用旧稿来保证百会话。

基准公开每会话初始上下文（建议先固定约 8k tokens）、保留尾部 / 输出上限、Provider 脚本、插件、子进程类型与同步设置。Linux 报整棵进程树 PSS 和 RSS，Windows / macOS 使用相应私有内存 / footprint 指标，不能把口径不同的数字直接相减。客户端和 faux 服务单列，并同时给出总和。

| 维度 | 验收要求 / 待校准预算 |
| --- | --- |
| 已确认操作 | 受理 / 完成 / 保存回执在进程、OS 崩溃和受控掉电后零丢失；完成事实不重跑，未知外部结果不盲目重试 |
| 掉电持久性 | WAL + FULL 与文件 / artifact 发布协议通过；客户端已收回执集合可全部对账；仅 `kill -9` 不算达标 |
| 并发容量 | 20 项目 × 5 个独立 Worker；8.1 的 A / B 场景中 100 个会话持续推进，不用排队数、空闲 PID 或流数量替代 |
| 多端同步 | 受控 LAN 下，已提交更新到其他前台客户端应用 p95 ≤200ms |
| 重连 / 离线 | 有界快照恢复 p95 ≤2s；离线禁止浏览 / 操作，会话不从缓存继续开放；未知回执按原 ID 对账 |
| 控制面 | 100 个 Worker、合计约 1000 个已提交增量 / 秒时，取消受理 / 查询 p95 ≤200ms；实际终止外部进程耗时另计 |
| 冷会话 | 1000 个未加载 Session 不产生 1000 个 Harness / watcher / 进程，内存随目录页而非完整历史增长 |
| 内存 | 先测空载 Worker、8k 上下文 Worker 和增量成本；百会话标准负载的 daemon 全进程树 PSS 暂争取 ≤16 GiB，客户端单列；该数字需 P0 实测校准 |
| 资源上限 | 100 活跃会话内满足预算；额外请求可排队 / 拒绝，不能降低活跃数来换达标。报告工具 / PTY / 插件宿主、FD、WAL 与输出开销 |
| UI 插件 | Agent 依据公开组件 / skill 生成 UI，无需改主应用即可两端显示；历史 replay / 实时追加一致，未知 renderer 可降级 |
| 插件切换 | 已构建、无在途调用的普通插件切换 p95 ≤1s；构建、drain、UI 下载和实际生效分别计时 |
| 重载泄漏 | 1000 次更新收敛后进程 / FD / 监听器回到基线；UI 容器可回收，无持续线性内存增长 |
| 长稳测试 | 24h 百会话混合负载 + 故障注入下结果正确、没有饿死的项目、队列 / WAL / artifact / 内存受预算约束 |
| 移动发布 | iOS / Android / 指定鸿蒙真机会话 + PTY 输入 / resize + 文件编辑保存 + 桌面冲突处理均通过，不只验证聊天页面 |

未达标时首先定位序列化、持久化、全量快照、模块重复加载与子进程成本，不能仅通过关闭持久化、减少测试输出或删除兼容性来达到数字。

## 12. 迁移策略

### 12.1 保留资产

- React 19、现有布局、shadcn / Base UI、主题与工作区组件。
- `src/lib/omo.ts` 统一入口的思想；用 v2 transport / adapter 替换其后端，不向业务组件新增 `window.omo`。
- Turn / RenderBlock 展示经验、虚拟列表、终端与 diff UI。
- workspace guard、凭据保护、事件可靠性测试思路与已有用量 / Provider UI。
- 已有 Windows / macOS / Linux Desktop 与 Web / Server 的交付路径、终端、文件编辑、Git、连接配置；先建立现状 fixture 和功能清单，再替换后端实现。

客户端仅保留展示适配，不把 Pi 原始消息 / 生命周期直接变成 v2 的永久协议。已有能力不重复计为 v2 新建任务，但“v1 已支持该平台”也不意味着新的多进程 daemon、可靠保存与服务升级已通过该平台验证。

### 12.2 迁移顺序

1. 先定义 omo protocol 与 `AgentRuntime` 接口；v1 adapter 可暂时实现该接口，提供渐进切换入口。
2. 将本地 / 远程公共业务收敛到独立 daemon，先解决“两个执行实现”。
3. 新建 v2 Session 使用 core Harness + 新存储；旧 Session 保持 legacy 标识与只读浏览 / 显式导入。
4. 前端依次迁移目录、打开 / 历史、Prompt / queue / abort、模型配置、工具状态、Interaction。
5. 原生 omo 插件 SDK 成熟后重组内置工具与 UI；用户旧插件由 Agent 按教程改写，不建设 Pi extension 兼容层。
6. v2 验收达标后停止新建 legacy Session，移除过渡用的 `pi-coding-agent` 执行适配；JSONL 导入能力独立保留。

### 12.3 JSONL 导入

- 保留原文件只读备份，不覆盖、不和 TUI 同时写。
- 记录来源 server、文件 hash、Session ID 与 entry ID 映射；重复导入幂等。
- 保留完整树、parent 关系、模型 / thinking 变化、压缩、branch summary、自定义 entry、usage 与时间。
- 区分旧 `firstKeptEntryId` 和新 `retainedTail` 压缩形式，不能只复制 UI 可见消息。
- 未识别扩展数据原样存为有 schema 标识的 legacy payload，不执行其代码。
- 缺失 tool result、半行 JSONL、损坏尾部、附件缺失明确记录诊断；不要把中断工具恢复成 running。
- 新 Session 路径不再作为客户端身份；workspace 路径迁移需要用户确认映射。
- 用导入后的历史树、上下文构建、费用和 UI fixture 与 v1 比较。

切换后 v2 新写入不反向双写 Pi JSONL。需要返回旧工具时使用显式导出 / fork；回滚 UI 不代表能把 v2 执行事实无损还原成 v1。

## 13. 实施阶段与发布门槛

阶段顺序保留，但不延续旧稿未经验证的 beta 工期承诺。100 个独立进程、FULL 持久提交和鸿蒙终端 / 编辑器会影响关键路径；P0 先给出实测与风险分解，再由团队估时。复用已有三平台 / Web 资产，不为市场、Pi 插件兼容或 Hub / Runner 排期。

### P0：高风险验证，先以两周 timebox 组织，不以到期替代通过

交付：

- 固定上游版本的 export / 实现 / 风险清单。
- Node + core Harness + SQLite + faux provider 的最小完整运行。
- 两个客户端观察同一个 lane，关闭客户端、重启 worker 后恢复。
- command 去重与“已受理但响应丢失”的对账方案；专门验证 queue / Interaction 的事务边界。
- Chord 同形 reload、结构增删替代路径、自身请求 reload、旧调用 drain、失败宿主重建的实验。
- 百会话进程实验：20 项目 × 5 Worker，测单 Worker 与全进程树内存、吞吐、FULL commit 延迟，比较 8.6 的存储路径；同拓扑 Bun 冒烟。
- 独立回执记录器 + 存储故障实验，证明先落盘后确认，并制定三平台可控断电验证流程；不能只做进程 kill。
- UI 插件最小样例：稳定业务节点 + keyed renderer + 组件复用 + 热替换，不修改主客户端；核对其内存 / dispose 行为。
- RN / RNOH 版本及原生模块兼容清单，确定真机 / 发行版目标；不在此阶段重写完整移动界面。

Gate：不依赖未实现 `watchSession()`；明确公开接口、adapter / 上游补丁边界。若百会话 FULL 写入路径、唯一写者、持久受理或安全恢复无法成立，则不进入主迁移，不将指标改成排队任务。

### P1：统一 daemon 与持久命令

交付：模块化 control plane、设备配对 / 撤销、workspace guard、规范 Session 身份、durable inbox、Session Worker Supervisor、选定存储路径、artifact / 文件可靠保存、三平台服务生命周期。

Gate：客户端断线不取消 Run；同一 Session 不能双开写者；已确认受理、结果和保存通过故障对账，掉电测试覆盖真实同步边界；daemon 离线不会被客户端缓存伪装为可用。

### P2：Web / Desktop 多端闭环

交付：协议 schema、TS client、WSS 多路复用、快照 / cursor / reset、历史分页、共享运行状态、草稿、持久 Interaction、文件 CAS 与终端输入权；复用现有三平台 / Web UI。

同时交付 RN / RNOH 风险样机：连接 daemon、会话流、一个声明式插件节点、真实 PTY 输入 / resize、文本编辑保存；尽早暴露 WebSurface、IME 和原生模块问题。

Gate：两端同时 Prompt、答题、取消、改模型、保存文件的结果确定；慢端不拖垮快端；离线 / 重连与 reducer 通过；鸿蒙样机不以 Android 兼容 APK 代替。

### P3：插件 v1 与热重载

交付：omo plugin SDK、公开 UI 组件 / schema、Slots / Conversation 节点注册表、构建预设、catalog、skill 教程及 7.11 的四个参考插件；三平台可信 Plugin Host、generation registry、安全切换与状态恢复。

额外用子 Agent / 后台任务验证父子预算、取消和产物返回。复杂自定义 Web UI 与声明式 UI 都有最小可用路径；不是只交付工具注册后把 UI 插件无限后移。

Gate：Agent 在预授权内可自动生成 / 激活，但不能自行扩大权限；新 UI 无需重建主应用，多端 / replay 一致，失败有 fallback；1000 次 reload 不累积宿主 / UI 容器 / 监听器，旧 schema 不串代。发布范围是可信插件故障隔离，不以强沙箱或 Pi 兼容层为前提。

### P4：并发、长稳与运行时决策

交付：公平调度、Provider 限流、子任务预算、进程树回收、输出背压、懒加载、百会话完整 Node / Bun 基准报告。

Gate：100 个独立会话进程跨项目持续推进，A / B workload 与 24h soak 通过；额外 1000 命令只验证排队 / 公平性。全程保持 FULL 及同等文件持久性，通过掉电 / 故障对账；不能用降并发、降同步级别或只报单进程内存过关。根据数据记录 Bun ADR。

### P5：迁移与 beta 发布

交付：JSONL importer、过渡数据 / 执行适配、配置迁移、备份 / 恢复、协议兼容窗口、Windows / macOS / Linux 打包与 daemon 升级、Web / Server 部署及回退说明；不交付 Pi 插件兼容层。

Gate：真实长会话和自定义历史数据 fixture 通过，v1 数据不被破坏；已有终端 / 文件 / Git 功能回归；三平台进程回收与可靠保存通过；不存在业务组件绕开统一后端入口。

### 后续发布

- **v2.0**：Windows / macOS / Linux Desktop + Web / Server，共享用户自控 daemon、明确离线状态、掉电 RPO=0 的持久确认、可信自生成 UI / 工具插件、100 个并发会话进程；Bun 可选。
- **v2.1**：RN / RNOH 移动首版，包含会话、终端、文件编辑、插件声明式展示、弱网 / 后台恢复和平台推送。协议与真机风险实验从 P2 开始，不等桌面全部完成才研究。
- **后续优化**：基于实测继续优化内存、存储、编辑体验和插件组件。Hub / Runner、离线会话阅读、市场与 Pi 兼容不进入当前路线。

## 14. 必须建立的测试矩阵

| 类别 | 核心场景 |
| --- | --- |
| 存储 | 上游 Storage / Repo conformance、FULL 配置检查、事务 / fsync 失败、磁盘满、只读、备份、迁移、fork scope、Storage Host IPC 丢回执 |
| 掉电 | 独立客户端已收回执对账；控制库 / 执行库 / 文件替换 / artifact / generation 的边界断电；三平台真实同步语义，不以进程 kill 代替 |
| 受理 | 并发相同 mutation ID、不同 payload、受理前 / 后 kill、回包丢失、队列追加重复、过期 revision |
| 恢复 | 在 assistant / tool effect_pending / outcome_ready / result 提交边界 kill；安全工具重放，不安全工具不重跑 |
| 同步 | snapshot 与 live 竞态、重复 / 缺口 / 旧 epoch、过期 cursor、多端不同历史页、序号持久化失败 |
| 插件 | 编译 / 激活 / 清理失败、同形 / 结构更新、在途调用、schema skew、memo / migration、自己请求 reload、预授权与权限增量 |
| UI 插件 / 教程 | Agent 按 skill 生成、组件 / 插槽检查、完整 replay / prepend / live 一致、稳定 key、未知 renderer fallback、iframe / WebSurface 清理、示例 CI |
| 安全 | 未授权订阅、伪造身份 / generation、路径逃逸、SSRF、secret 泄漏、无权限能力调用、恶意安装脚本 |
| 调度 | 公平性、嵌套 fan-out、父等子不死锁、限流重试风暴、取消树、超预算 |
| 进程 | 大输出、无限输出、fork 子进程、超时、不退出、PID 重用、PTY 控制权、平台差异 |
| 跨端 | Web / 三平台 Electron 一致；离线隐藏 / 禁用、不自动发送新命令、原 ID 对账；RN / RNOH 真机会话 + PTY + 文件编辑 / 冲突、IME、后台与通知 |
| 性能 | 100 个独立 Session Worker 持续推进、固定数据集与 FULL 配置、全进程树 CPU / 内存、FD、GC、event loop lag、WAL / artifact 与 fsync 放大 |

优先使用可控时钟、gating storage、faux provider 与注入式进程退出，在确定的边界制造竞态；少用“sleep 一下再猜状态”。不对真实有破坏性的工具进行自动重放验证。

## 15. 建议代码边界与 ADR

以下是未来结构提案，本次不创建这些模块：

```text
apps/
  daemon/                 控制面、网络入口、调度
  session-worker/         每活跃根 Session 一个进程、唯一 Harness 写者
  storage-host/           可选共享容器 / group commit 路线，须 P0 验证
  plugin-host/            可信插件故障隔离、可替换运行环境
  desktop/                Electron 薄壳
  web/                    现有 React 逐步迁移
  mobile/                 RN / RNOH、原生与 WebSurface 平台 adapter
packages/
  protocol/               schema、版本、wire fixtures
  client/                 TS transport、同步 store、重连
  domain/                 命令、身份、预算等纯产品模型
  agent-runtime/          core Harness / legacy adapter
  storage/                omo repo、Session backend adapter、迁移
  sync/                   投影、快照、水位与背压
  plugin-sdk/             稳定作者契约、catalog、构建预设、测试工具
  plugin-ui/              共享 Web 组件、插槽、节点 renderer
  plugin-ui-schema/       target-neutral 节点与声明式组件 / 动作
  plugin-ui-native/       移动阶段 RN / RNOH renderer
  plugin-runtime/         构建、generation、宿主与能力 broker
  execution/              进程、PTY、workspace 与沙箱适配
  telemetry/              adapter、schema、脱敏与指标
skills/
  omo-plugin-authoring/   SKILL.md、模板、分主题教程和可执行示例
```

不必第一天迁成大型 monorepo。先在现有仓库形成这些依赖边界，再按实际构建和测试需求拆包。

必须形成的 ADR：

- ADR-001：单个用户自控 daemon、离线不可查看 / 操作、唯一写者与三平台服务生命周期。
- ADR-002：采用新 AgentHarness 的范围、缺口与退出策略。
- ADR-003：Session Storage 布局、跨库 inbox / outbox、幂等与掉电 RPO=0 的同步 / 发布协议。
- ADR-004：公开协议、snapshot / delta、cursor、RN / RNOH 版本及平台 adapter。
- ADR-005：可信自生成插件、UI Slots / 节点 / 组件 / skill、generation 和状态迁移；不做市场 / Pi 兼容。
- ADR-006：100 个独立 Session Worker、子 Agent lane、共享 broker、预算、公平调度与取消树。
- ADR-007：相同百进程拓扑及 FULL 持久性下的 Node / Bun 基准与平台选择。

## 16. 已确认决策与剩余工程验证

产品问题已经收敛，不再把它们作为阻塞项反复询问：

| 已确认要求 | 对应实现边界 |
| --- | --- |
| 所有端连接用户控制的 daemon，关机就离线 | 第 4 / 6 节：不做常在线 Hub、接管和离线会话阅读 |
| 用户 / Agent 生成可信插件，提供组件和 skill | 第 7 节：公开 UI SDK、目录、模板、测试和预授权热激活；没有市场 |
| 不兼容 Pi 扩展 | 7.9：Agent 按源码改写；JSONL 数据导入独立保留 |
| 三平台桌面与 Web / Server 起步 | 第 12 / 13 节：复用现有能力，只替换必要执行 / 协议边界 |
| 跨项目 100 个同时运行的会话进程 | 第 8 / 11 节：100 独立 Session Worker，排队 / 空闲进程 / 流计数不替代 |
| 移动优先共享框架，支持鸿蒙、终端和文件编辑 | 6.7：RN + RNOH、共享 TS 模型、原生 / WebSurface adapter、真机发布 gate |
| 已确认操作原则上掉电零丢失 | 5.8：RPO=0、FULL、文件 / artifact 持久发布、回执对账与硬件边界 |
| 参考 DeepSeek cookbook 的 UI 插件 | 7.0：已按固定提交文档补充 Conversation / Slots / client bundle 对照 |

剩余事项是工程验证，而非重新讨论产品方向：

1. 百会话标准 workload 的硬件 / 内存预算与 Storage 路线 A / B，以 P0 数据定案。
2. 各 OS / 文件系统 / 驱动的同步写、服务生命周期、进程树回收与断电测试证据。
3. RN / RNOH 的共同版本、目标鸿蒙发行版 / 真机、WebSurface / 输入法 / 安全存储 / 推送模块及分发渠道规则。
4. UI 插件的最小组件 / slot 清单、历史节点版本兼容，以及 core admission / Storage adapter 能否只使用公开接口完成。

**立即验证两个闭环：**

- **功能 / 恢复闭环**：两端共享一个持久 lane，Agent 按 skill 生成“工具 + UI 进度卡片”，预授权内热激活，另一端看到节点并完成 Interaction；重启 Worker 后任务、答案、节点和 generation 一致；daemon 离线时不能继续浏览 / 操作。
- **容量 / 持久性闭环**：20 项目 × 5 独立 Worker，FULL 提交、固定输出、外部记录回执，运行混合负载并注入故障 / 断电；确认 100 个会话都在推进、所有已收回执仍在、没有重复外部执行或失控资源。

先证明这两条路径，再展开主迁移和移动产品化，比先重写全部 UI 或全面换 Bun 更有价值。

## 17. 调研依据

### omo 本地资料

- [架构](architecture.md)、[客户端模式](client-modes.md)、[会话](sessions.md)、[可靠性](reliability.md)。
- [安全](security.md)、[终端](terminal.md)、[验证与部署](deployment-testing.md)。
- `server/pi-service.cjs`、`server/event-store.cjs`、`server/index.cjs`。
- `electron/main.cjs`、`src/lib/remote-api.ts`、`package.json`。

### 已安装 `0.85.0` 包与公开类型 / 实现

- `@earendil-works/pi-coding-agent/README.md`；`docs/sdk.md`、`extensions.md`、`tui.md`、`session-format.md`、`sessions.md`、`compaction.md`、`packages.md` 及 SDK / reload 示例。
- `@earendil-works/pi-ai/README.md`：Provider、CredentialStore、compact frames、faux provider、runtime / browser 边界。
- `@earendil-works/pi-agent-core/README.md`、`dist/index.d.ts`、`dist/harness/agent-harness.d.ts`、`session/types.d.ts`、`types.d.ts`、`session/testing/index.d.ts`。
- core `dist/harness/runtime/harness.js`、`lane.js`、`progress.js`、`drive/recovery.js`、`drive/tools.js`：未实现 API、受理、快照、恢复与重放行为。
- `@earendil-works/chord/README.md`、`src/delta/README.md`、`dist/types.d.ts`、`dist/facets/host.js`：实际复制与 reload 边界。
- `@earendil-works/pi-telemetry/README.md`：被动 adapter、显式上下文、安全与 conformance。
- `@earendil-works/pi-server/README.md`：实验 server / attachment 与应用宿主所有权。

### 固定版本的外部核验

- [Chord 实现规划](https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/chord/PLANNING.md)：含仍在规划中的能力，不能当作全部已交付。
- [实验应用 Facet 设计](https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/agent/docs/plugins.md) 与 [RPC 设计](https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/agent/docs/rpc.md)：用于边界比较；示例与当前实现有差异。
- [SQLite Session backend npm 0.85.0](https://www.npmjs.com/package/@earendil-works/pi-session-backend-sqlite-node/v/0.85.0)：读取该版本发布包 README 与类型，核实 factory、布局及“不提供跨进程所有权”声明。

### 本次需求澄清后的补充核验

- [DeepSeek 扩展 cookbook · UI 插件](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/extension-cookbook#ui-插件)；[固定提交的中文源码](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/cookbook/extension-cookbook.zh.md)。页面示例省略辅助实现，不是可直接运行的 omo API。
- 同提交的 [Conversation](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/subsystems/conversation.zh.md)、[Slots](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/subsystems/slots.zh.md)、[Client 模块](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/subsystems/client-modules.zh.md)、[设置卡片教程](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/cookbook/adding-a-settings-card.zh.md)：核对节点归并、类型化贡献、产物版本及开发 / 生产 HMR 边界；未运行其应用。
- [React Native · Out-of-Tree Platforms](https://reactnative.dev/docs/out-of-tree-platforms) 及其指向的 [React Native OpenHarmony 仓库](https://atomgit.com/CPF-RN/ohos_react_native)：核实平台适配路线存在；未完成 RNOH 版本矩阵、原生模块或真机构建验证。
- [SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)、[fullfsync](https://www.sqlite.org/pragma.html#pragma_fullfsync)、[checkpoint_fullfsync](https://www.sqlite.org/pragma.html#pragma_checkpoint_fullfsync)：WAL 的 FULL / NORMAL 掉电持久性差异，以及 macOS 同步边界；本次未执行实际掉电实验。

上游升级时重新运行 P0 契约与故障测试，再更新该文档；不通过追踪 `latest` 自动改变 omo 的公开协议或执行保证。
