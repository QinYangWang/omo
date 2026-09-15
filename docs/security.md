# Server 安全边界

## API 认证

设置 `OMO_TOKEN` 后，所有 `/api/v1` 业务接口要求 Bearer Token。Server 使用固定长度检查和 `crypto.timingSafeEqual` 比较 Token。

以下请求不要求 Token：

- `/api/v1/health`
- 已通过 Token 创建的 Browser 代理能力 URL（`/api/v1/browser/:id/proxy`）
- 静态 Web 文件

Server 托管的 Web 也需要 Token：首次打开进入引导页登录，Token 存于浏览器 localStorage 后免登。不依赖 `Sec-Fetch-Site` 等浏览器头（Safari 不发送 Fetch Metadata 头，不可靠）。

`OMO_TOKEN` 为空时 API 认证关闭，Server 启动日志会输出警告。

## Workspace 限制

`OMO_WORKSPACE_ROOTS` 是逗号分隔的允许目录。`server/workspace.cjs` 对已存在路径执行：

1. `path.resolve`
2. `fs.realpath`
3. 对 workspace root 执行 realpath
4. 使用 `path.relative` 判断目标是否位于允许 root 内

该检查覆盖：

- Project cwd
- Pi Agent cwd
- Files
- Git
- Terminal cwd

因此通过 `..` 或指向 workspace 外部的符号链接不能越界。

Pi Session JSONL 通常位于 workspace 外，因此使用独立的 Session root guard。默认 Session root 是：

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions
```

Session 打开和导入路径必须位于该目录。

## WebSocket ticket

WebSocket 不直接携带长期 Bearer Token。客户端先通过已认证 HTTP 创建终端或请求新 ticket。

Ticket 属性：

- UUID
- 绑定单个 terminal ID
- 30 秒过期
- 使用后立即删除
- 无效 ticket 的 Upgrade 返回 HTTP 401

## 请求限制

- JSON Body 最大 16MB。
- Prompt 最多 8 个图片附件。
- 单个图片附件的 base64 数据最多 8,000,000 个字符。
- 文件文本读取最大 300KB。
- 图片文件读取最大 5,900,000 bytes。
- Git 输出缓冲最大 8MB。
- 终端输出环形缓冲默认 2MB。
- 无连接终端空闲 30 分钟后回收。
- Browser 单次请求体上限 16MB、响应上限 32MB；代理会话空闲 30 分钟后回收，页面资源使用随机会话 ID 能力 URL。

Browser 代理只接受 HTTP/HTTPS URL，不接受 URL 中的用户名和密码。创建、导航和关闭代理会话需要 Bearer Token；资源请求使用随机会话 URL，以便浏览器 iframe 加载时不必暴露长期 Token，代理也不会把 omo 请求的 `Authorization` header 转发给目标网站。Server 部署在公网时应配合 HTTPS、强 Token 和网络访问控制，因为代理请求由 Server 主动发起。

`POST /pi/context-details` 返回当前有效系统提示、工具定义、上下文文件内容和扩展注入的隐藏消息，可能包含项目内部指令或其他敏感上下文。该接口不使用 Browser 能力 URL 例外，始终要求 Server Bearer Token；前端不会将快照写入 localStorage。

## Electron 凭据

Electron 将所有远程服务器的 Token 交给主进程的 `safeStorage`：

```text
Renderer → preload IPC → safeStorage.encryptString → remote-server.json
```

`remote-server.json` 保存服务器列表 `{ servers: [{ id, name, url, encryptedToken }] }`；旧版单服务器格式在读取时自动迁移。渲染层不能直接读取加密文件。操作系统加密服务不可用时，不写入明文 Token。

## Web 凭据

静态 Web 将远程服务器列表（含 Token）保存于当前 Origin 的 localStorage（`omo:servers`）；Server 托管的 Web 登录当前服务器的 Token 也以保留 id `local` 存于同一列表。跨域访问由 `OMO_CORS_ORIGINS` 控制。Server 对允许的 Origin返回对应的 `Access-Control-Allow-Origin`，并允许 Authorization、Content-Type 和 Last-Event-ID 请求头。
