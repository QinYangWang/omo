# ADR-005：可信自生成插件、不做市场与 Pi 兼容层

- 状态：已确认
- 规划依据：§7（含 §7.0 DeepSeek 对照、§7.9 不兼容声明、§7.10 SDK、§7.11 skill 闭环）
- 日期：v2 规划确认时

## 决策

1. 插件来源仅限用户/Agent 在受信任环境内生成；没有第三方市场、商店审核、发布者签名网络，也不承诺 Pi 扩展 API 兼容。
2. omo 交付公开插件 SDK：`@omo/plugin-sdk`、`@omo/plugin-ui`、`@omo/plugin-ui-schema`（Web 复用 shadcn/Base UI）、构建预设与 test kit，以及 `omo-plugin-authoring` skill 教程；均为拟议交付物，随 P3 落地。
3. 插件是 facet 组合：contract/manifest + 可选 runtime facet + presentation 节点定义 + 声明式 UI + 可选隔离 web facet；不是「一份在所有地方执行的 JS」。
4. 热更新默认在下一模型轮次的安全点生效；已发出请求固定 toolsetRevision/插件 generation；旧调用 drain 有时限与资源上限。
5. 故障隔离而非强沙箱：`node:vm`/Worker 不是恶意代码边界；可信声明必须如实标注；危险工作聚焦权限误用、凭据边界、错误代码与资源失控。
6. 持久 Interaction（审批/问题）先落盘后投影；答案单事务只接受一次；不用 `getMemo()`+`setMemo()` 冒充原子抢答。

## 后果

- v1 旧插件由 Agent 按 skill 教程做源码级改写，不建设 `ctx.ui`/TUI Component/Pi extension events 的 shim。
- UI 渲染器与后端 generation 可不同代，但必须声明可读的 payload 版本；不兼容时保留旧 renderer 或文本/artifact fallback。
- Agent 在预授权范围内可自动生成/激活插件，但不能自行扩大权限。

## 退出/再评估条件

若 P3 证明 Chord reload + drain 无法承载安全切换（1000 次重载泄漏不收敛），缩减首版热更新范围为「重启 Worker 生效」，热激活另立 ADR。
