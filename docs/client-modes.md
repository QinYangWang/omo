# 客户端模式与连接配置

## Electron 本地模式

Electron preload 暴露 `window.omo`。该对象将 Project、Session、Pi、Provider、配额、用量、文件、Git 和终端调用转换为 IPC。

未配置远程 Server URL 时，`src/lib/omo.ts` 使用该接口。

## Electron 远程模式

Settings → General 提供：

- Server URL
- Access Token
- Test connection
- Save and reconnect
- Use local

保存远程配置后页面重新加载，`src/lib/omo.ts` 改用 `src/lib/remote-api.ts`。Project 路径、Session、文件、Git、Provider、Pi Agent 和终端均属于远程服务器，并与连接同一 Server 的静态 Web 实时同步。

### Token 持久化

`electron/preload.cjs` 暴露 `window.omoSecure`，通过 IPC 调用 Electron `safeStorage`：

- `loadRemoteConfig()`
- `saveRemoteConfig(url, token)`
- `clearRemoteConfig()`

Server URL 以普通文本存入 Electron userData 的 `remote-server.json`；Token 经 `safeStorage.encryptString()` 加密并以 Base64 保存。读取时使用 `safeStorage.decryptString()`。

如果操作系统加密能力不可用，Electron 拒绝持久化非空 Token。已有 localStorage 远程配置会在初始化时尝试迁移到 safeStorage。

## 静态 Web

omo Server 返回 `index.html` 时注入：

```js
window.__OMO_SERVER_URL__ = location.origin
```

因此由 Server 托管的 Web 自动连接同源 API。独立部署的 Web 可在 Settings → General 中填写远程地址。

浏览器没有 Electron safeStorage，Server URL 和 Token 保存在当前 Origin 的 localStorage：

```text
omo:server-url
omo:server-token
```

跨域部署需要在 Server 设置 `OMO_CORS_ORIGINS`。HTTPS 页面连接远程服务时，远程服务也必须使用 HTTPS/WSS，避免浏览器混合内容限制。

## 浏览器开发预览

没有 Electron preload 且没有远程 Server URL 时，`src/lib/web-preview.ts` 提供预览数据，使 Vite 页面可以独立检查 UI。该预览不执行真实 Pi、文件、Git 或终端操作。
