const { app, BrowserWindow, shell, ipcMain, dialog } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const { readFileSync } = require("fs");
const { pathToFileURL } = require("url");
const { spawn, execFile } = require("child_process");

let win;
let termProc = null;
const piSessions = new Map();
const sdkPromise = import("@earendil-works/pi-coding-agent");
let modelRuntimePromise;
const historyPages = new Map();
const authPrompts = new Map();

async function getModelRuntime() {
  const { ModelRuntime } = await sdkPromise;
  modelRuntimePromise ||= ModelRuntime.create();
  return modelRuntimePromise;
}

// ---------- pi-quotas (@latentminds/pi-quotas, TS 源码经 tsx 加载) ----------
let tsxRegistered = false;
async function fetchQuotas(force) {
  const pkgRoot = path.join(os.homedir(), ".pi/agent/npm/node_modules/@latentminds/pi-quotas");
  if (!readFileSyncOrNull(path.join(pkgRoot, "package.json"))) {
    return { installed: false, items: [] };
  }
  if (!tsxRegistered) {
    require("tsx/esm/api").register();
    tsxRegistered = true;
  }
  const quotas = await import(pathToFileURL(path.join(pkgRoot, "src/lib/quotas.ts")).href);
  const stored = JSON.parse(readFileSyncOrNull(path.join(os.homedir(), ".pi/agent/auth.json")) || "{}");
  const runtime = await getModelRuntime();
  const authStorage = {
    get: (provider) => stored[provider],
    getApiKey: async (provider) => {
      const cred = stored[provider];
      if (cred?.type === "api_key" && cred.key) return cred.key;
      const auth = (await runtime.getAuth(provider).catch(() => undefined))?.auth;
      const header = auth?.headers?.Authorization;
      return auth?.apiKey ?? header?.replace(/^Bearer\s+/i, "");
    },
  };
  const results = await quotas.fetchAllProviderQuotas(authStorage, { force });
  return {
    installed: true,
    items: results.map(({ provider, result }) => ({
      provider,
      label: quotas.PROVIDER_LABELS[provider],
      success: result.success,
      error: result.success ? undefined : result.error,
      windows: result.success
        ? result.data.windows.map((w) => ({ ...w, resetsAt: new Date(w.resetsAt).toISOString() }))
        : [],
    })),
  };
}
function readFileSyncOrNull(p) {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

// Keep the UI independent of Pi's TUI extensions: read the same persisted JSONL
// records used by @tmustier/pi-usage-extension.
async function usageSnapshot() {
  const root = process.env.PI_CODING_AGENT_DIR || path.join(require("os").homedir(), ".pi", "agent");
  const dir = path.join(root, "sessions");
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const providers = new Map();
  async function walk(folder) {
    let entries; try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith(".jsonl")) {
        let lines; try { lines = (await fs.readFile(file, "utf8")).split("\\n"); } catch { continue; }
        for (const line of lines) { let m; try { m = JSON.parse(line); } catch { continue; }
          if (!m || m.type !== "message" || m.message?.role !== "assistant" || !m.message.usage) continue;
          const u = m.message.usage, p = m.message.provider || "unknown", model = m.message.model || "unknown";
          const input = Number(u.input || 0), output = Number(u.output || 0), cacheRead = Number(u.cacheRead || 0), cacheWrite = Number(u.cacheWrite || 0), cost = Number(u.cost?.total || 0);
          totals.input += input; totals.output += output; totals.cacheRead += cacheRead; totals.cacheWrite += cacheWrite; totals.cost += cost;
          const key = `${p}/${model}`, row = providers.get(key) || { provider: p, model, messages: 0, tokens: 0, cost: 0 };
          row.messages++; row.tokens += input + output + cacheWrite; row.cost += cost; providers.set(key, row);
        }
      }
    }
  }
  await walk(dir);
  return { totals, providers: [...providers.values()].sort((a, b) => b.cost - a.cost) };
}

// ---------- pi SDK ----------
async function ensurePi(sessionId, cwd, sessionPath) {
  if (piSessions.has(sessionId)) return piSessions.get(sessionId);
  const creating = (async () => {
    const { createAgentSession, ModelRuntime, SessionManager } = await sdkPromise;
    modelRuntimePromise ||= ModelRuntime.create();
    const modelRuntime = await modelRuntimePromise;
    const { session } = await createAgentSession({
      cwd,
      modelRuntime,
      sessionManager: sessionPath ? SessionManager.open(sessionPath) : SessionManager.create(cwd),
      tools: ["read", "powershell", "edit", "write", "grep", "find", "ls"],
    });
    session.subscribe((event) => win?.webContents.send("pi:event", { sessionId, event }));
    return session;
  })();
  piSessions.set(sessionId, creating);
  try {
    return await creating;
  } catch (error) {
    piSessions.delete(sessionId);
    throw error;
  }
}

// ---------- git ----------
const git = (args, cwd) =>
  new Promise((resolve) =>
    execFile("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) =>
      resolve(e ? String(stderr || e.message) : stdout)
    )
  );

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#1a1a1a",
      symbolColor: "#a3a3a3",
      height: 40,
    },
    backgroundColor: "#1a1a1a",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      webviewTag: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  // pi SDK: direct AgentSession, no subprocess/protocol
  const displayMessages = (messages) => {
    const items = [];
    const tools = new Map();
    const clip = (value, max) => {
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return text.length > max ? `${text.slice(0, max)}\n… truncated ${text.length - max} chars` : text;
    };
    for (const message of messages) {
      if (message.role === "user") {
        const text = typeof message.content === "string"
          ? message.content
          : message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
        if (text) items.push({ id: crypto.randomUUID(), role: "user", text: clip(text, 80_000), timestamp: message.timestamp });
      } else if (message.role === "assistant") {
        let text = "";
        for (const part of message.content) {
          if (part.type === "text") text += part.text;
          if (part.type === "thinking") {
            if (text) items.push({ id: crypto.randomUUID(), role: "assistant", text: clip(text, 100_000), timestamp: message.timestamp });
            text = "";
            items.push({
              id: crypto.randomUUID(),
              role: "thinking",
              text: clip(part.thinking, 40_000),
              status: "done",
            });
          }
          if (part.type === "toolCall") {
            if (text) items.push({ id: crypto.randomUUID(), role: "assistant", text: clip(text, 100_000), timestamp: message.timestamp });
            text = "";
            const item = {
              id: part.id,
              role: "tool",
              toolName: part.name,
              input: clip(part.arguments, 8_000),
              status: "running",
            };
            tools.set(part.id, item);
            items.push(item);
          }
        }
        if (text) items.push({ id: crypto.randomUUID(), role: "assistant", text: clip(text, 100_000), timestamp: message.timestamp });
      } else if (message.role === "toolResult") {
        const output = message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
        const item = tools.get(message.toolCallId);
        if (item) Object.assign(item, { output: clip(output, 16_000), status: message.isError ? "error" : "done" });
        else items.push({
          id: message.toolCallId,
          role: "tool",
          toolName: message.toolName,
          output: clip(output, 16_000),
          status: message.isError ? "error" : "done",
        });
      }
    }
    let turnStart;
    let assistantItems = [];
    let lastAssistant;
    const finishTurn = () => {
      if (!lastAssistant) return;
      lastAssistant.turnEnd = true;
      lastAssistant.completedAt = lastAssistant.timestamp;
      lastAssistant.durationMs = turnStart && lastAssistant.timestamp
        ? Math.max(0, lastAssistant.timestamp - turnStart)
        : undefined;
      lastAssistant.copyText = assistantItems.map((item) => item.text).join("\n\n");
      for (const item of assistantItems) if (item !== lastAssistant) delete item.timestamp;
      assistantItems = [];
      lastAssistant = undefined;
    };
    for (const item of items) {
      if (item.role === "user") {
        finishTurn();
        turnStart = item.timestamp;
      } else if (item.role === "assistant") {
        lastAssistant = item;
        assistantItems.push(item);
      }
    }
    finishTurn();
    return items;
  };

  ipcMain.handle("pi:open", async (_e, { sessionId, cwd, sessionPath }) => {
    const { SessionManager } = await sdkPromise;
    if (sessionPath) {
      const manager = SessionManager.open(sessionPath);
      const all = displayMessages(manager.buildSessionContext().messages);
      historyPages.set(sessionId, all);
      const cursor = Math.max(0, all.length - 80);
      ensurePi(sessionId, cwd, sessionPath).catch((error) =>
        win?.webContents.send("pi:event", { sessionId, event: { type: "omo_error", message: String(error) } })
      );
      return {
        messages: all.slice(cursor),
        cursor,
        hasMore: cursor > 0,
        sessionId: manager.getSessionId(),
        sessionFile: sessionPath,
      };
    }
    const session = await ensurePi(sessionId, cwd);
    return {
      messages: [],
      cursor: 0,
      hasMore: false,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      model: session.model ? { id: session.model.id, provider: session.model.provider, name: session.model.name || session.model.id } : null,
      thinkingLevel: session.thinkingLevel,
    };
  });
  ipcMain.handle("pi:models", async () => {
    const runtime = await getModelRuntime();
    return (await runtime.getAvailable()).map((model) => ({
      id: model.id,
      provider: model.provider,
      name: model.name || model.id,
    }));
  });
  ipcMain.handle("pi:set-model", async (_e, { sessionId, provider, modelId }) => {
    const session = await piSessions.get(sessionId);
    const runtime = await modelRuntimePromise;
    const model = runtime?.getModel(provider, modelId);
    if (!session || !model) throw new Error("Model is not available");
    await session.setModel(model);
  });
  ipcMain.handle("pi:set-thinking", async (_e, { sessionId, level }) => {
    const session = await piSessions.get(sessionId);
    if (!session) throw new Error("Open a session first");
    session.setThinkingLevel(level);
  });
  ipcMain.handle("pi:history", (_e, { sessionId, before }) => {
    const all = historyPages.get(sessionId) || [];
    const end = Math.max(0, Math.min(before, all.length));
    const cursor = Math.max(0, end - 80);
    return { messages: all.slice(cursor, end), cursor, hasMore: cursor > 0 };
  });
  ipcMain.handle("pi:prompt", async (_e, { sessionId, message, cwd, sessionPath }) => {
    const session = await ensurePi(sessionId, cwd || app.getAppPath(), sessionPath);
    session
      .prompt(message, session.isStreaming ? { streamingBehavior: "followUp" } : undefined)
      .catch((error) =>
        win?.webContents.send("pi:event", {
          sessionId,
          event: { type: "omo_error", message: error instanceof Error ? error.message : String(error) },
        })
      );
    return { sessionId: session.sessionId, sessionFile: session.sessionFile };
  });
  ipcMain.handle("pi:abort", async (_e, { sessionId }) => {
    const session = await piSessions.get(sessionId);
    await session?.abort();
  });

  ipcMain.handle("usage:snapshot", () => usageSnapshot());

  // Provider auth via Pi ModelRuntime
  ipcMain.handle("providers:list", async () => {
    const runtime = await getModelRuntime();
    return Promise.all(runtime.getProviders().map(async (provider) => {
      let auth;
      let error;
      try { auth = await runtime.checkAuth(provider.id, { signal: AbortSignal.timeout(5_000) }); }
      catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      return {
        id: provider.id,
        name: provider.name,
        connected: !!auth,
        authType: auth?.type,
        source: auth?.source,
        hasApiKey: !!provider.auth.apiKey?.login,
        hasOAuth: !!provider.auth.oauth,
        subscription: !!provider.auth.oauth?.isSubscription,
        error,
      };
    }));
  });
  ipcMain.handle("providers:login", async (_event, { providerId, type }) => {
    const runtime = await getModelRuntime();
    await runtime.login(providerId, type, {
      notify(event) {
        if (event.type === "auth_url") shell.openExternal(event.url);
        if (event.type === "device_code") shell.openExternal(event.verificationUri);
        win?.webContents.send("providers:auth-event", { kind: "notify", providerId, event });
      },
      prompt(prompt) {
        const requestId = crypto.randomUUID();
        win?.webContents.send("providers:auth-event", { kind: "prompt", providerId, requestId, prompt });
        return new Promise((resolve, reject) => {
          const abort = () => {
            authPrompts.delete(requestId);
            reject(prompt.signal?.reason || new Error("Authentication cancelled"));
          };
          prompt.signal?.addEventListener("abort", abort, { once: true });
          authPrompts.set(requestId, {
            resolve: (value) => {
              prompt.signal?.removeEventListener("abort", abort);
              resolve(value);
            },
            reject,
          });
        });
      },
    });
    return true;
  });
  ipcMain.handle("providers:respond", (_event, { requestId, value }) => {
    const pending = authPrompts.get(requestId);
    if (!pending) return false;
    authPrompts.delete(requestId);
    pending.resolve(value);
    return true;
  });
  ipcMain.handle("providers:cancel", (_event, requestId) => {
    const pending = authPrompts.get(requestId);
    if (!pending) return false;
    authPrompts.delete(requestId);
    pending.reject(new Error("Authentication cancelled"));
    return true;
  });
  ipcMain.handle("providers:logout", async (_event, providerId) => {
    const runtime = await getModelRuntime();
    await runtime.logout(providerId);
    return true;
  });

  ipcMain.handle("quotas:all", (_event, force) => fetchQuotas(!!force));

  // terminal (ponytail: 裸 shell 管道, 无 pty; 需要真 pty 时换 node-pty)
  ipcMain.handle("term:create", (_e, cwd) => {
    if (termProc) return;
    termProc = spawn("powershell.exe", ["-NoLogo"], { cwd: cwd || app.getAppPath() });
    termProc.stdout.on("data", (d) => win?.webContents.send("term:data", d.toString()));
    termProc.stderr.on("data", (d) => win?.webContents.send("term:data", d.toString()));
    termProc.on("exit", () => (termProc = null));
  });
  ipcMain.on("term:input", (_e, data) => termProc?.stdin.write(data));

  // fs
  ipcMain.handle("fs:list", async (_e, dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  });
  ipcMain.handle("fs:read", async (_e, p) => {
    const stat = await fs.stat(p);
    if (stat.size > 300 * 1024) return { error: "文件过大" };
    return { content: await fs.readFile(p, "utf8") };
  });

  // git
  ipcMain.handle("git:status", (_e, cwd) => git(["status", "--porcelain"], cwd));
  ipcMain.handle("git:diff", (_e, { cwd, file }) => git(["diff", "HEAD", "--", file], cwd));
  ipcMain.handle("git:branches", async (_e, cwd) => {
    const output = await git(["branch", "--format=%(refname:short)|%(HEAD)"], cwd);
    if (String(output).startsWith("fatal:")) return [];
    return String(output).split("\n").filter(Boolean).map((line) => {
      const [name, head] = line.split("|");
      return { name, current: head === "*" };
    });
  });

  // Projects and real Pi sessions
  const projectsFile = path.join(app.getPath("userData"), "projects.json");
  const readProjects = async () => {
    try { return JSON.parse(await fs.readFile(projectsFile, "utf8")); } catch { return []; }
  };
  const writeProjects = (projects) => fs.writeFile(projectsFile, JSON.stringify(projects, null, 2));
  ipcMain.handle("projects:list", readProjects);
  ipcMain.handle("projects:add", async () => {
    const picked = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    if (picked.canceled) return null;
    const cwd = picked.filePaths[0];
    const projects = await readProjects();
    const existing = projects.find((p) => p.cwd.toLowerCase() === cwd.toLowerCase());
    if (existing) return existing;
    const project = { id: crypto.randomUUID(), name: path.basename(cwd), cwd };
    projects.push(project);
    await writeProjects(projects);
    return project;
  });
  ipcMain.handle("sessions:list", async (_e, cwd) => {
    const { SessionManager } = await sdkPromise;
    return (await SessionManager.list(cwd)).map((s) => ({ ...s, created: +s.created, modified: +s.modified }));
  });
  ipcMain.handle("sessions:all", async () => {
    const { SessionManager } = await sdkPromise;
    return (await SessionManager.listAll()).map((s) => ({ ...s, created: +s.created, modified: +s.modified }));
  });
  ipcMain.handle("sessions:import", async (_e, { sourcePath, cwd }) => {
    const { SessionManager } = await sdkPromise;
    const manager = SessionManager.forkFrom(sourcePath, cwd);
    return manager.getSessionFile();
  });

  ipcMain.handle("app:cwd", () => app.getAppPath());

  win.webContents.on("console-message", (event) =>
    console.log(`[renderer:${event.level}] ${event.message}`)
  );
  win.webContents.on("render-process-gone", (_event, details) =>
    console.error("Renderer process gone:", details)
  );

  if (!app.isPackaged) {
    win.loadURL("http://localhost:5188");
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(createWindow);
app.on("before-quit", async () => {
  for (const pending of piSessions.values()) (await pending).dispose();
});
app.on("window-all-closed", () => app.quit());
