# Server 安全边界

## API 认证

设置 `OMO_TOKEN` 后，所有 `/api/v1` 业务接口要求 Bearer Token。Server 使用固定长度检查和 `crypto.timingSafeEqual` 比较 Token。

以下请求不要求 Token：

- `/api/v1/health`
- 静态 Web 文件

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

## Electron 凭据

Electron 将远程 Token 交给主进程的 `safeStorage`：

```text
Renderer → preload IPC → safeStorage.encryptString → remote-server.json
```

渲染层不能直接读取加密文件。操作系统加密服务不可用时，不写入明文 Token。

## Web 凭据

静态 Web 将 Token 保存于当前 Origin 的 localStorage。跨域访问由 `OMO_CORS_ORIGINS` 控制。Server 对允许的 Origin返回对应的 `Access-Control-Allow-Origin`，并允许 Authorization、Content-Type 和 Last-Event-ID 请求头。
