# 远程终端

## 生命周期

Remote API 调用：

```http
POST /api/v1/terminals
{ "cwd": "/workspace/project" }
```

`server/terminal-service.cjs` 对 cwd 执行 workspace realpath 校验，然后使用 `node-pty` 创建 PTY：

- Windows：`powershell.exe -NoLogo`
- 其他平台：`$SHELL --login`，默认 `/bin/bash --login`
- 初始大小：120×30
- `TERM=xterm-256color`
- `COLORTERM=truecolor`

创建成功后返回 terminal ID、当前输出 offset 和一次性 WebSocket ticket。

## WebSocket 数据

输入：

```json
{ "type": "input", "data": "git status\n" }
```

尺寸：

```json
{ "type": "resize", "cols": 120, "rows": 30 }
```

输出：

```json
{
  "type": "output",
  "offset": 100,
  "data": "...",
  "nextOffset": 120
}
```

每个输出 chunk 使用字符长度计算 offset。同一终端允许多个 WebSocket 订阅者。

## 输出缓冲

每个终端最多保留 2MB 输出。缓冲由已发送 chunk 数组组成：

- `start`：chunk 起始 offset
- `end`：chunk 结束 offset
- `data`：原始终端文本

超出缓冲后移除最旧 chunk，并推进 `floor`。客户端重连时传入 `after`：

- `after` 在缓冲内：返回缺失 chunk。
- `after` 小于 `floor`：发送 `reset`，客户端显示 `\x1bc` 清空屏幕后从 `floor` 继续。
- `after` 大于当前输出：不产生输出，等待实时事件。

## 重连

WebSocket 关闭后，Remote API 调用 HTTP ticket 接口申请新 ticket，再携带当前 offset 建立新连接。

重连等待：

```text
1s → 2s → 4s → 8s → 16s → 30s
```

加入最多 20% 抖动。重连期间 PTY 不关闭，因此网络断开不会停止服务器终端进程。

## 回收

Server 每分钟检查终端：

- 有连接：更新时间戳，不回收。
- 无连接且空闲不足 30 分钟：保留。
- 无连接且空闲超过 30 分钟：结束未退出的 PTY并删除记录。

终端进程退出时向订阅者发送 `exit` 消息。

## 本地终端

Electron 本地终端同样使用 `node-pty`，并通过 IPC 转发 xterm.js 的输入、输出与尺寸变化，因此支持全屏交互程序。每个会话可以通过“+”创建多个独立终端；关闭终端标签会结束对应 PTY 并释放 xterm。前端使用 Unicode 11 宽度表、10,000 行 scrollback，并通过 `ResizeObserver` 合并连续 resize 后同步 PTY；远程连接建立或重连时会再次发送最新尺寸。远程终端额外提供输出缓冲与断线重连。
