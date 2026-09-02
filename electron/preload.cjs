const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("omoSecure", {
  loadRemoteConfig: () => ipcRenderer.invoke("remote-config:load"),
  saveRemoteConfig: (url, token) => ipcRenderer.invoke("remote-config:save", { url, token }),
  clearRemoteConfig: () => ipcRenderer.invoke("remote-config:clear"),
});

contextBridge.exposeInMainWorld("omo", {
  pi: {
    open: (sessionId, cwd, sessionPath) => ipcRenderer.invoke("pi:open", { sessionId, cwd, sessionPath }),
    history: (sessionId, before) => ipcRenderer.invoke("pi:history", { sessionId, before }),
    models: () => ipcRenderer.invoke("pi:models"),
    setModel: (sessionId, provider, modelId) => ipcRenderer.invoke("pi:set-model", { sessionId, provider, modelId }),
    setThinking: (sessionId, level) => ipcRenderer.invoke("pi:set-thinking", { sessionId, level }),
    prompt: (sessionId, message, cwd, sessionPath) => ipcRenderer.invoke("pi:prompt", { sessionId, message, cwd, sessionPath }),
    abort: (sessionId) => ipcRenderer.invoke("pi:abort", { sessionId }),
    onEvent: (cb) => {
      const h = (_e, data) => cb(data);
      ipcRenderer.on("pi:event", h);
      return () => ipcRenderer.removeListener("pi:event", h);
    },
  },
  term: {
    create: (cwd) => ipcRenderer.invoke("term:create", cwd),
    input: (data) => ipcRenderer.send("term:input", data),
    onData: (cb) => {
      const h = (_e, d) => cb(d);
      ipcRenderer.on("term:data", h);
      return () => ipcRenderer.removeListener("term:data", h);
    },
  },
  fs: {
    list: (dir) => ipcRenderer.invoke("fs:list", dir),
    read: (p) => ipcRenderer.invoke("fs:read", p),
  },
  git: {
    status: (cwd) => ipcRenderer.invoke("git:status", cwd),
    diff: (cwd, file) => ipcRenderer.invoke("git:diff", { cwd, file }),
    branches: (cwd) => ipcRenderer.invoke("git:branches", cwd),
  },
  providers: {
    quotas: (force) => ipcRenderer.invoke("quotas:all", force),
    list: () => ipcRenderer.invoke("providers:list"),
    login: (providerId, type) => ipcRenderer.invoke("providers:login", { providerId, type }),
    respond: (requestId, value) => ipcRenderer.invoke("providers:respond", { requestId, value }),
    cancel: (requestId) => ipcRenderer.invoke("providers:cancel", requestId),
    logout: (providerId) => ipcRenderer.invoke("providers:logout", providerId),
    onAuthEvent: (cb) => {
      const h = (_event, data) => cb(data);
      ipcRenderer.on("providers:auth-event", h);
      return () => ipcRenderer.removeListener("providers:auth-event", h);
    },
  },
  usage: {
    snapshot: () => ipcRenderer.invoke("usage:snapshot"),
  },
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    add: (path) => ipcRenderer.invoke("projects:add", path),
    pickDirectory: () => ipcRenderer.invoke("projects:pick-directory"),
  },
  sessions: {
    list: (cwd) => ipcRenderer.invoke("sessions:list", cwd),
    all: () => ipcRenderer.invoke("sessions:all"),
    import: (sourcePath, cwd) => ipcRenderer.invoke("sessions:import", { sourcePath, cwd }),
  },
  cwd: () => ipcRenderer.invoke("app:cwd"),
  usage: { snapshot: () => ipcRenderer.invoke("usage:snapshot") },
});
