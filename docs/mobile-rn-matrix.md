# RN / RNOH 版本与原生模块兼容清单（P0 交付，§6.7）

> 状态：版本清单与风险记录。真机构建验证在 P2 风险样机阶段执行。RN 官方将 OpenHarmony 列为合作方维护的 out-of-tree 平台；「支持鸿蒙」= 指定 HarmonyOS/OpenHarmony 真机验收，安装 Android APK 兼容版不算达标。

## 1. 版本基线（2026-09 调研）

| 组件 | 版本 | 来源 | 备注 |
| --- | --- | --- | --- |
| React Native | 0.87.x（npm latest 0.87.1） | npm `react-native` | iOS/Android 主线 |
| React | 随 RN 版本固定（RN 0.87 → React 19.x） | RN 依赖 | 不要求与 Web 端 React 19 共享运行时 |
| RNOH (React Native OpenHarmony) | 不在 npm registry；经 atomgit `CPF-RN/ohos_react_native` / ohpm 渠道分发 | atomgit/ohpm | **分发渠道与 npm 不同是固有风险**：版本交集需人工跟踪并在锁文件中钉死 |
| Hermes / 新架构 | 随 RN 版本 | RN | 新架构（Fabric/TurboModules）为默认目标 |

RNOH 发行版与 RN 版本的兼容矩阵需在选型时从其仓库 release notes 逐项核对；P0 不锁具体 RNOH 版本，锁定的是**决策程序**：先确定目标鸿蒙发行版（HarmonyOS NEXT 与 OpenHarmony 分别记录），再取与之兼容的 RNOH 发行版，再取其兼容的 RN 版本交集。

## 2. 原生模块需求清单（移动端首版功能矩阵，§6.7）

| 能力 | 模块方案 | iOS/Android | 鸿蒙 | 风险 |
| --- | --- | --- | --- | --- |
| 会话/历史/流式 | 纯 TS（`@omo/client` 协议 SDK） | ✅ | ✅ | 无原生依赖 |
| 安全存储（token/凭据） | Keychain / Keystore 模块；鸿蒙用 Asset Store / KeyStore adapter | ✅ 成熟 | ⚠️ 需 RNOH 侧适配层 | 中 |
| 终端 | 优先 WebSurface 复用现有 xterm 表面；原生渲染为优化项 | ✅ WebView | ⚠️ ArkWeb | 高（IME/控制键/resize 真机门槛） |
| 文件编辑 | 先 WebSurface 编辑面，再评估原生 | ✅ | ⚠️ 同上 | 高（中文 IME/选择/光标） |
| WebSocket/HTTPS | RN 内置 + 平台网络栈 | ✅ | ⚠️ RNOH 网络模块核对 | 中 |
| 推送 | APNs/FCM/鸿蒙推送 adapter，只发最少任务提示 | ✅ | ⚠️ 厂商通道 | 中 |
| 后台生命周期 | 平台 adapter；挂起断开属正常，前台重连取快照 | ✅ | ⚠️ 鸿蒙后台约束核对 | 中 |
| WebSurface 隔离桥 | 受限 bridge，仅当前会话/artifact/终端能力 | ✅ | ⚠️ ArkWeb bridge 核对 | 中 |

## 3. 版本决策程序（P2 风险样机前必须完成）

1. 确定目标鸿蒙发行版与真机清单（HarmonyOS NEXT / OpenHarmony 分别记录 API level）。
2. 从 RNOH 仓库 release notes 取与之兼容的 RNOH 版本，及其声明兼容的 RN 版本区间。
3. 取 iOS/Android 目标 RN 版本与该区间的交集；交集为空则按平台分版本维护（允许，不追求单版本）。
4. 钉死 React/RN/Hermes/RNOH/关键原生模块五元组进锁文件；升级需重跑真机验收。
5. 核对动态代码加载与渠道规则：不允许动态执行 JS 的渠道使用随包 renderer + 声明式数据（§6.7 末段）。

## 4. P0 已确认事实

- RN out-of-tree 平台机制存在且 RNOH 仓库活跃（规划 §17 已核验链接）。
- RNOH 不在 npm registry —— 依赖管理需额外镜像/锁文件策略（本清单 §1）。
- omo 协议层（`@omo/protocol`、`@omo/client` 规划）为纯 TS、无 DOM/Node 依赖，可直接进 RN bundle；插件 UI 走声明式 schema（`@omo/plugin-ui-schema` 已实现 target-neutral 组件协议），不需要在主 bundle 内运行 Chord Node loader。

## 5. 风险样机验收门槛（P2 Gate 摘录）

真机完成：连接 daemon → 会话流 → 一个声明式插件节点渲染 → 真实 PTY 输入/resize → 文本编辑保存（与桌面端并发冲突处理）→ 后台挂起/前台重连校准。任一不过，降级方案为对应能力走受控 WebSurface，不得默默砍鸿蒙目标。
