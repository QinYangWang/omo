"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("omoSecure", {
  clearRemoteConfig: () => ipcRenderer.invoke("remote-config:clear"),
  loadRemoteConfig: () => ipcRenderer.invoke("remote-config:load"),
  saveRemoteConfig: (servers) =>
    ipcRenderer.invoke("remote-config:save", { servers }),
});

contextBridge.exposeInMainWorld("omo", {
  browser: {
    close: () => Promise.resolve(),
    navigate: () =>
      Promise.reject(
        new Error("The server browser is unavailable in local mode")
      ),
    open: () =>
      Promise.reject(
        new Error("The server browser is unavailable in local mode")
      ),
  },
  cwd: () => ipcRenderer.invoke("app:cwd"),
  fs: {
    list: (dir) => ipcRenderer.invoke("fs:list", dir),
    read: (p, binary) => ipcRenderer.invoke("fs:read", { binary, path: p }),
  },
  git: {
    branches: (cwd) => ipcRenderer.invoke("git:branches", cwd),
    createBranch: (cwd, name) =>
      ipcRenderer.invoke("git:create-branch", { cwd, name }),
    diff: (cwd, file) => ipcRenderer.invoke("git:diff", { cwd, file }),
    status: (cwd) => ipcRenderer.invoke("git:status", cwd),
  },
  models: {
    list: () => ipcRenderer.invoke("models:list"),
    setEnabled: (enabled) =>
      ipcRenderer.invoke("models:set-enabled", { enabled }),
  },
  packages: {
    install: (source) => ipcRenderer.invoke("packages:install", { source }),
    list: () => ipcRenderer.invoke("packages:list"),
    remove: (source) => ipcRenderer.invoke("packages:remove", { source }),
  },
  pi: {
    abort: (sessionId) => ipcRenderer.invoke("pi:abort", { sessionId }),
    branch: (sessionId, entryId) =>
      ipcRenderer.invoke("pi:branch", { entryId, sessionId }),
    commands: (sessionId, cwd, sessionPath) =>
      ipcRenderer.invoke("pi:commands", { cwd, sessionId, sessionPath }),
    contextDetails: (sessionId, cwd, sessionPath) =>
      ipcRenderer.invoke("pi:context-details", { cwd, sessionId, sessionPath }),
    contextUsage: (sessionId, cwd, sessionPath) =>
      ipcRenderer.invoke("pi:context-usage", { cwd, sessionId, sessionPath }),
    history: (sessionId, before) =>
      ipcRenderer.invoke("pi:history", { before, sessionId }),
    models: () => ipcRenderer.invoke("pi:models"),
    onEvent: (cb) => {
      const h = (_e, data) => cb(data);
      ipcRenderer.on("pi:event", h);
      return () => ipcRenderer.removeListener("pi:event", h);
    },
    open: (sessionId, cwd, sessionPath) =>
      ipcRenderer.invoke("pi:open", { cwd, sessionId, sessionPath }),
    prompt: (sessionId, message, cwd, sessionPath, images) =>
      ipcRenderer.invoke("pi:prompt", {
        cwd,
        images,
        message,
        sessionId,
        sessionPath,
      }),
    release: (sessionId) => ipcRenderer.invoke("pi:release", { sessionId }),
    retain: (sessionId) => ipcRenderer.invoke("pi:retain", { sessionId }),
    setModel: (sessionId, provider, modelId) =>
      ipcRenderer.invoke("pi:set-model", { modelId, provider, sessionId }),
    setThinking: (sessionId, level) =>
      ipcRenderer.invoke("pi:set-thinking", { level, sessionId }),
    sync: (sessionId, sessionPath, turnCount, tailItemCount) =>
      ipcRenderer.invoke("pi:sync", {
        sessionId,
        sessionPath,
        tailItemCount,
        turnCount,
      }),
  },
  projects: {
    add: (path) => ipcRenderer.invoke("projects:add", path),
    list: () => ipcRenderer.invoke("projects:list"),
    pickDirectory: () => ipcRenderer.invoke("projects:pick-directory"),
  },
  providers: {
    cancel: (requestId) => ipcRenderer.invoke("providers:cancel", requestId),
    list: () => ipcRenderer.invoke("providers:list"),
    login: (providerId, type) =>
      ipcRenderer.invoke("providers:login", { providerId, type }),
    logout: (providerId) => ipcRenderer.invoke("providers:logout", providerId),
    onAuthEvent: (cb) => {
      const h = (_event, data) => cb(data);
      ipcRenderer.on("providers:auth-event", h);
      return () => ipcRenderer.removeListener("providers:auth-event", h);
    },
    quotas: (force) => ipcRenderer.invoke("quotas:all", force),
    respond: (requestId, value) =>
      ipcRenderer.invoke("providers:respond", { requestId, value }),
  },
  sessions: {
    all: () => ipcRenderer.invoke("sessions:all"),
    clone: (sessionPath) =>
      ipcRenderer.invoke("sessions:clone", { sessionPath }),
    context: (sessionPath) =>
      ipcRenderer.invoke("sessions:context", { sessionPath }),
    details: (sessionPath, cwd) =>
      ipcRenderer.invoke("sessions:details", { cwd, sessionPath }),
    import: (sourcePath, cwd) =>
      ipcRenderer.invoke("sessions:import", { cwd, sourcePath }),
    list: (cwd) => ipcRenderer.invoke("sessions:list", cwd),
    rename: (sessionPath, name) =>
      ipcRenderer.invoke("sessions:rename", { name, sessionPath }),
  },
  skills: { list: () => ipcRenderer.invoke("skills:list") },
  term: {
    close: (key = "default") => ipcRenderer.invoke("term:close", key),
    create: (cwd, cols, rows, key = "default") =>
      ipcRenderer.invoke("term:create", { cols, cwd, key, rows }),
    input: (data, key = "default") =>
      ipcRenderer.send("term:input", { data, key }),
    onData: (cb, key = "default") => {
      const handler = (_event, message) => {
        if (message.key === key) {
          cb(message.data);
        }
      };
      ipcRenderer.on("term:data", handler);
      return () => ipcRenderer.removeListener("term:data", handler);
    },
    resize: (cols, rows, key = "default") =>
      ipcRenderer.send("term:resize", { cols, key, rows }),
  },
  usage: { snapshot: () => ipcRenderer.invoke("usage:snapshot") },
  windowControls: {
    setTitleBarOverlay: (options) =>
      ipcRenderer.send("window:set-title-bar-overlay", options),
  },
});
