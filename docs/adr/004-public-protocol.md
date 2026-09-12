# ADR-004：公开协议、序号分层与多端适配

- 状态：已确认（协议 v0 已在 `packages/protocol` 建模）
- 规划依据：§6.2–§6.7、§3.5
- 日期：v2 规划确认时

## 决策

1. omo 拥有外层协议：framing、认证、路由、重连、背压与版本；Chord RemoteServiceTransport 只作内部适配边界。
2. 传输：HTTPS 承载登录/配对、command、query、历史分页与 artifact；单条 WSS 多路复用控制/订阅；终端与大输出走独立有预算的流；SSE 仅作只读降级。
3. 身份分层：`serverId` 是持久逻辑身份（非 URL）；`requestId` 是一次传输调用，`commandId` 是跨重连业务操作；存储 commit seq、omo 重放 cursor、Chord state seq 分属不同域。
4. 跨语言大整数一律十进制字符串；时间一律 RFC 3339 字符串；协议由运行时 schema 校验（不只 TS interface），未知控制指令必须拒绝。
5. 订阅顺序：装捕获 → 快照+水位 C → 发快照 → 补 C 后增量 → 客户端应用成功才推进 appliedCursor；cursor 过期/epoch 变更/codec 失配 → `reset_required` 重取快照。首版允许重连直接 fresh snapshot + 历史分页。
6. 移动端走 OpenAPI/JSON Schema + TS SDK + golden wire fixtures；不运行 Chord Node loader 或 Harness。

## 已验证（P0）

- `packages/protocol` v0：命令信封（§5.4）、帧信封（§6.3）、十进制字符串 cursor、canonical JSON + sha256 payloadHash、golden fixtures 通过。

## 后果

- 持久控制/结果与实时进度是两条数据路径；首版只推已可靠提交的进度。
- 协议版本、omo 数据版本、上游 storage 版本、plugin SDK 版本分别管理。

## 退出/再评估条件

若 WSS 多路复用在真实移动端网络下不达标，允许按 §6.2 增补 SSE 降级路径；不改变身份与 cursor 分层。
