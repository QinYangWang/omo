# Provider、配额与用量

## Provider 管理

Provider 由 Pi `ModelRuntime` 提供。列表包含：

- Provider ID 与名称
- 是否已连接
- 认证类型与来源
- 是否支持 API Key
- 是否支持 OAuth
- 是否为订阅
- 认证检查错误

认证状态使用 `ModelRuntime.checkAuth`，每次检查超时 5 秒。凭据不写入 omo 自建存储，继续使用 Pi 的 `~/.pi/agent/auth.json`。

## 登录流程

`login(providerId, type)` 使用：

- `type: "api_key"`：等待 API Key 或文本输入。
- `type: "oauth"`：启动 OAuth 流程。

Pi 发出的 text、secret、select 和 manual code 请求以 request ID 保存，并发送给 UI Dialog。UI 使用 respond 返回答案，cancel 拒绝未完成的认证 Promise。

Electron 本地模式收到 OAuth URL 时通过系统浏览器打开。Server 模式将认证事件写入 `__providers` 事件流；远程客户端收到 `auth_url` 或 `device_code` 后在浏览器新标签页打开。

登出调用 `ModelRuntime.logout(providerId)`。

## 配额

`server/quotas.cjs` 是 omo 内置的配额实现（Server 与 Electron 共用，不再依赖 `@latentminds/pi-quotas` 与 tsx），解析器参考了 pi-quotas 与 omo-run 的 omo-usage 扩展。

配额调用使用自定义 AuthStorage：

1. 优先读取 Pi `auth.json`。
2. API Key Provider 直接返回保存的 key。
3. 其他 Provider 查询 `ModelRuntime.getAuth()`。
4. 支持从 `Authorization: Bearer ...` Header 提取 Key。

结果覆盖 10 个订阅 Provider。`force=true` 绕过内置 TTL 缓存。

## 用量

Settings → Usage 支持中英文显示。订阅配额按返回的 quota window 各显示一条进度条；每条窗口不会额外渲染重复轨道。重置时间会按当前语言显示。

`server/usage.cjs` 和 Electron 本地模式扫描：

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/**/*.jsonl
```

聚合规则：

- 只统计 `type === "message"`。
- 只统计 `message.role === "assistant"`。
- 只统计存在 `message.usage` 的记录。
- 总计包含 input、output、cacheRead、cacheWrite 和 cost。
- 明细按 `provider/model` 聚合。
- tokens 使用 `input + output + cacheWrite`。
- providers 按 cost 降序排列。

JSONL 中无法解析的行会被忽略。Usage 页面当前展示已记录的 Session 用量，并按 provider/model 汇总。
