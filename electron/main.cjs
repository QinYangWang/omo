"use strict";
const {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  dialog,
  safeStorage,
} = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { spawn, execFile } = require("node:child_process");
const {
  createHistorySnapshot,
  historyPage,
  sessionHistoryMessages,
} = require("../server/display-messages.cjs");
const {
  installPackage,
  listModels,
  listPackages,
  listSkills,
  removePackage,
  setModelsEnabled,
} = require("../server/agent-config.cjs");
const { fetchQuotas: fetchProviderQuotas } = require("../server/quotas.cjs");
const { usageSnapshot: readUsageSnapshot } = require("../server/usage.cjs");

let win;
let termProc = null;
const piSessions = new Map();
const sdkPromise = import("@earendil-works/pi-coding-agent");
let modelRuntimePromise;
const historyPages = new Map();
const authPrompts = new Map();
const nativeTitleBarPlatforms = new Set(["win32", "linux"]);
const imageMime = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const MAX_TEXT_FILE_BYTES = 300 * 1024;
const MAX_IMAGE_FILE_BYTES = 5_900_000;
const MAX_IMAGE_DATA_LENGTH = 8_000_000;
const hexColor = /^#[\da-f]{6}$/i;

async function getModelRuntime() {
  const { ModelRuntime } = await sdkPromise;
  modelRuntimePromise ||= ModelRuntime.create();
  return modelRuntimePromise;
}

// ---------- provider quotas (in-process implementation) ----------
function fetchQuotas(force) {
  return fetchProviderQuotas(
    { runtime: getModelRuntime },
    path.join(os.homedir(), ".pi/agent"),
    force
  );
}

// Keep the UI independent of Pi's TUI extensions: read the same persisted JSONL
// records used by @tmustier/pi-usage-extension.
function usageSnapshot() {
  const root =
    process.env.PI_CODING_AGENT_DIR ||
    path.join(require("node:os").homedir(), ".pi", "agent");
  return readUsageSnapshot(path.join(root, "sessions"));
}

// ---------- pi SDK ----------
async function ensurePi(sessionId, cwd, sessionPath) {
  if (piSessions.has(sessionId)) {
    return piSessions.get(sessionId);
  }
  const creating = (async () => {
    const { createAgentSession, ModelRuntime, SessionManager } =
      await sdkPromise;
    modelRuntimePromise ||= ModelRuntime.create();
    const modelRuntime = await modelRuntimePromise;
    const { session } = await createAgentSession({
      cwd,
      modelRuntime,
      sessionManager: sessionPath
        ? SessionManager.open(sessionPath)
        : SessionManager.create(cwd),
      tools: ["read", "powershell", "edit", "write", "grep", "find", "ls"],
    });
    session.subscribe((event) =>
      win?.webContents.send("pi:event", { event, sessionId })
    );
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
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 8 * 1024 * 1024 },
      (e, stdout, stderr) => resolve(e ? String(stderr || e.message) : stdout)
    )
  );

ipcMain.on("window:set-title-bar-overlay", (_event, options) => {
  if (
    !win ||
    win.isDestroyed() ||
    !nativeTitleBarPlatforms.has(process.platform)
  ) {
    return;
  }
  const color = options?.color;
  const symbolColor = options?.symbolColor;
  if (!(hexColor.test(color) && hexColor.test(symbolColor))) {
    return;
  }
  win.setTitleBarOverlay({ color, symbolColor });
});

function createWindow() {
  win = new BrowserWindow({
    backgroundColor: "#0a0a0a",
    height: 900,
    titleBarOverlay: {
      color: "#0a0a0a",
      height: 40,
      symbolColor: "#a3a3a3",
    },
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      webviewTag: true,
    },
    width: 1440,
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  // pi SDK: direct AgentSession, no subprocess/protocol
  ipcMain.handle("pi:open", async (_e, { sessionId, cwd, sessionPath }) => {
    const { SessionManager } = await sdkPromise;
    if (sessionPath) {
      const manager = SessionManager.open(sessionPath);
      const history = createHistorySnapshot(sessionHistoryMessages(manager));
      historyPages.set(sessionId, history);
      const page = historyPage(history);
      const session = await ensurePi(sessionId, cwd, sessionPath);
      return {
        ...page,
        model: session.model
          ? {
              id: session.model.id,
              name: session.model.name || session.model.id,
              provider: session.model.provider,
            }
          : null,
        outline: history.metas,
        sessionFile: sessionPath,
        sessionId: manager.getSessionId(),
        thinkingLevel: session.thinkingLevel,
      };
    }
    const session = await ensurePi(sessionId, cwd);
    return {
      cursor: 0,
      hasMore: false,
      messages: [],
      model: session.model
        ? {
            id: session.model.id,
            name: session.model.name || session.model.id,
            provider: session.model.provider,
          }
        : null,
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
      thinkingLevel: session.thinkingLevel,
    };
  });
  ipcMain.handle("pi:models", async () => {
    const runtime = await getModelRuntime();
    return (await runtime.getAvailable()).map((model) => ({
      id: model.id,
      name: model.name || model.id,
      provider: model.provider,
    }));
  });
  ipcMain.handle("pi:commands", async (_e, { sessionId, cwd, sessionPath }) => {
    const session = await ensurePi(
      sessionId,
      cwd || app.getAppPath(),
      sessionPath
    );
    const extensions = session.extensionRunner
      .getRegisteredCommands()
      .map(({ invocationName, description }) => ({
        description,
        name: invocationName,
        source: "extension",
      }));
    const prompts = session.promptTemplates.map(({ name, description }) => ({
      description,
      name,
      source: "prompt",
    }));
    const skills = session.resourceLoader
      .getSkills()
      .skills.map(({ name, description }) => ({
        description,
        name: `skill:${name}`,
        source: "skill",
      }));
    return [...extensions, ...prompts, ...skills];
  });
  ipcMain.handle(
    "pi:set-model",
    async (_e, { sessionId, provider, modelId }) => {
      const session = await piSessions.get(sessionId);
      const runtime = await modelRuntimePromise;
      const model = runtime?.getModel(provider, modelId);
      if (!(session && model)) {
        throw new Error("Model is not available");
      }
      await session.setModel(model);
    }
  );
  ipcMain.handle("pi:set-thinking", async (_e, { sessionId, level }) => {
    const session = await piSessions.get(sessionId);
    if (!session) {
      throw new Error("Open a session first");
    }
    session.setThinkingLevel(level);
  });
  ipcMain.handle("pi:history", (_e, { sessionId, before }) =>
    historyPage(
      historyPages.get(sessionId) || { items: [], metas: [], turnStarts: [] },
      before
    )
  );
  ipcMain.handle(
    "pi:prompt",
    async (_e, { sessionId, message, cwd, sessionPath, images }) => {
      const session = await ensurePi(
        sessionId,
        cwd || app.getAppPath(),
        sessionPath
      );
      if (images !== undefined && !Array.isArray(images)) {
        throw new Error("Invalid image attachments");
      }
      if (images && images.length > 8) {
        throw new Error("Too many image attachments");
      }
      const validImages = images?.map((image) => {
        if (
          image?.type !== "image" ||
          typeof image.data !== "string" ||
          typeof image.mimeType !== "string" ||
          !image.mimeType.startsWith("image/") ||
          image.data.length > MAX_IMAGE_DATA_LENGTH
        ) {
          throw new Error("Invalid image attachment");
        }
        return image;
      });
      const options = {
        ...(session.isStreaming ? { streamingBehavior: "followUp" } : {}),
        ...(validImages?.length ? { images: validImages } : {}),
      };
      session
        .prompt(message, Object.keys(options).length ? options : undefined)
        .catch((error) =>
          win?.webContents.send("pi:event", {
            event: {
              message: error instanceof Error ? error.message : String(error),
              type: "omo_error",
            },
            sessionId,
          })
        );
      return { sessionFile: session.sessionFile, sessionId: session.sessionId };
    }
  );
  ipcMain.handle("pi:abort", async (_e, { sessionId }) => {
    const session = await piSessions.get(sessionId);
    await session?.abort();
  });

  ipcMain.handle("usage:snapshot", () => usageSnapshot());

  const agentDir = path.join(os.homedir(), ".pi/agent");
  ipcMain.handle("skills:list", () => listSkills(agentDir));
  ipcMain.handle("models:list", async () => {
    const runtime = await getModelRuntime();
    const available = (await runtime.getAvailable()).map((model) => ({
      id: model.id,
      name: model.name || model.id,
      provider: model.provider,
    }));
    return listModels(agentDir, available);
  });
  ipcMain.handle("models:set-enabled", async (_e, { enabled }) => {
    const runtime = await getModelRuntime();
    const available = (await runtime.getAvailable()).map((model) => ({
      id: model.id,
      name: model.name || model.id,
      provider: model.provider,
    }));
    return setModelsEnabled(agentDir, available, enabled);
  });
  ipcMain.handle("packages:list", () => listPackages(agentDir));
  ipcMain.handle("packages:install", (_e, { source }) =>
    installPackage(agentDir, source)
  );
  ipcMain.handle("packages:remove", (_e, { source }) =>
    removePackage(agentDir, source)
  );

  // Provider auth via Pi ModelRuntime
  ipcMain.handle("providers:list", async () => {
    const runtime = await getModelRuntime();
    return Promise.all(
      runtime.getProviders().map(async (provider) => {
        let auth;
        let error;
        try {
          auth = await runtime.checkAuth(provider.id, {
            signal: AbortSignal.timeout(5000),
          });
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        return {
          authType: auth?.type,
          connected: !!auth,
          error,
          hasApiKey: !!provider.auth.apiKey?.login,
          hasOAuth: !!provider.auth.oauth,
          id: provider.id,
          name: provider.name,
          source: auth?.source,
          subscription: !!provider.auth.oauth?.isSubscription,
        };
      })
    );
  });
  ipcMain.handle("providers:login", async (_event, { providerId, type }) => {
    const runtime = await getModelRuntime();
    await runtime.login(providerId, type, {
      notify(event) {
        if (event.type === "auth_url") {
          shell.openExternal(event.url);
        }
        if (event.type === "device_code") {
          shell.openExternal(event.verificationUri);
        }
        win?.webContents.send("providers:auth-event", {
          event,
          kind: "notify",
          providerId,
        });
      },
      prompt(prompt) {
        const requestId = crypto.randomUUID();
        win?.webContents.send("providers:auth-event", {
          kind: "prompt",
          prompt: { ...prompt, signal: undefined },
          providerId,
          requestId,
        });
        return new Promise((resolve, reject) => {
          const abort = () => {
            authPrompts.delete(requestId);
            reject(
              prompt.signal?.reason || new Error("Authentication cancelled")
            );
          };
          prompt.signal?.addEventListener("abort", abort, { once: true });
          authPrompts.set(requestId, {
            reject,
            resolve: (value) => {
              prompt.signal?.removeEventListener("abort", abort);
              resolve(value);
            },
          });
        });
      },
    });
    return true;
  });
  ipcMain.handle("providers:respond", (_event, { requestId, value }) => {
    const pending = authPrompts.get(requestId);
    if (!pending) {
      return false;
    }
    authPrompts.delete(requestId);
    pending.resolve(value);
    return true;
  });
  ipcMain.handle("providers:cancel", (_event, requestId) => {
    const pending = authPrompts.get(requestId);
    if (!pending) {
      return false;
    }
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
    if (termProc) {
      return;
    }
    termProc = spawn("powershell.exe", ["-NoLogo"], {
      cwd: cwd || app.getAppPath(),
    });
    termProc.stdout.on("data", (d) =>
      win?.webContents.send("term:data", d.toString())
    );
    termProc.stderr.on("data", (d) =>
      win?.webContents.send("term:data", d.toString())
    );
    termProc.on("exit", () => {
      termProc = null;
    });
  });
  ipcMain.on("term:input", (_e, data) => termProc?.stdin.write(data));

  // fs
  ipcMain.handle("fs:list", async (_e, dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => ({ dir: e.isDirectory(), name: e.name }))
      .sort(
        (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)
      );
  });
  ipcMain.handle("fs:read", async (_e, input) => {
    const { path: filePath, binary = false } =
      typeof input === "string" ? { path: input } : input || {};
    const stat = await fs.stat(filePath);
    const type = imageMime[path.extname(filePath).toLowerCase()];
    const maxBytes =
      binary && type ? MAX_IMAGE_FILE_BYTES : MAX_TEXT_FILE_BYTES;
    if (stat.size > maxBytes) {
      return { error: "文件过大" };
    }
    if (binary && type) {
      return {
        data: (await fs.readFile(filePath)).toString("base64"),
        mimeType: type,
      };
    }
    return { content: await fs.readFile(filePath, "utf8") };
  });

  // git
  ipcMain.handle("git:status", (_e, cwd) =>
    git(["status", "--porcelain"], cwd)
  );
  ipcMain.handle("git:diff", (_e, { cwd, file }) =>
    git(["diff", "HEAD", "--", file], cwd)
  );
  ipcMain.handle("git:branches", async (_e, cwd) => {
    const output = await git(
      ["branch", "--format=%(refname:short)|%(HEAD)"],
      cwd
    );
    if (String(output).startsWith("fatal:")) {
      return [];
    }
    return String(output)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, head] = line.split("|");
        return { current: head === "*", name };
      });
  });

  // Projects and real Pi sessions
  const projectsFile = path.join(app.getPath("userData"), "projects.json");
  const readProjects = async () => {
    try {
      return JSON.parse(await fs.readFile(projectsFile, "utf8"));
    } catch {
      return [];
    }
  };
  const writeProjects = (projects) =>
    fs.writeFile(projectsFile, JSON.stringify(projects, null, 2));
  ipcMain.handle("projects:list", readProjects);
  ipcMain.handle("projects:pick-directory", async () => {
    const picked = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
    });
    return picked.canceled ? null : picked.filePaths[0];
  });
  ipcMain.handle("projects:add", async (_e, selectedPath) => {
    let cwd = selectedPath;
    if (!cwd) {
      const picked = await dialog.showOpenDialog(win, {
        properties: ["openDirectory"],
      });
      if (picked.canceled) {
        return null;
      }
      [cwd] = picked.filePaths;
    }
    const stat = await fs.stat(cwd).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error("Directory does not exist");
    }
    const projects = await readProjects();
    const existing = projects.find(
      (p) => p.cwd.toLowerCase() === cwd.toLowerCase()
    );
    if (existing) {
      return existing;
    }
    const project = { cwd, id: crypto.randomUUID(), name: path.basename(cwd) };
    projects.push(project);
    await writeProjects(projects);
    return project;
  });
  ipcMain.handle("sessions:list", async (_e, cwd) => {
    const { SessionManager } = await sdkPromise;
    return (await SessionManager.list(cwd)).map((s) => ({
      ...s,
      created: +s.created,
      modified: +s.modified,
    }));
  });
  ipcMain.handle("sessions:all", async () => {
    const { SessionManager } = await sdkPromise;
    return (await SessionManager.listAll()).map((s) => ({
      ...s,
      created: +s.created,
      modified: +s.modified,
    }));
  });
  ipcMain.handle("sessions:import", async (_e, { sourcePath, cwd }) => {
    const { SessionManager } = await sdkPromise;
    const manager = SessionManager.forkFrom(sourcePath, cwd);
    return manager.getSessionFile();
  });

  ipcMain.handle("app:cwd", () => app.getAppPath());

  const remoteConfigFile = path.join(
    app.getPath("userData"),
    "remote-server.json"
  );
  const decryptToken = (encryptedToken) => {
    if (!(encryptedToken && safeStorage.isEncryptionAvailable())) {
      return "";
    }
    try {
      return safeStorage.decryptString(Buffer.from(encryptedToken, "base64"));
    } catch {
      return "";
    }
  };
  ipcMain.handle("remote-config:load", async () => {
    let stored;
    try {
      stored = JSON.parse(await fs.readFile(remoteConfigFile, "utf8"));
    } catch {
      return [];
    }
    if (Array.isArray(stored.servers)) {
      return stored.servers
        .filter((server) => server && typeof server.url === "string")
        .map((server) => ({
          id: server.id || crypto.randomUUID(),
          name: server.name || server.url,
          token: decryptToken(server.encryptedToken),
          url: server.url || "",
        }));
    }
    // Migrate the legacy single-server configuration.
    if (stored.url) {
      return [
        {
          id: crypto.randomUUID(),
          name: stored.url,
          token: decryptToken(stored.encryptedToken),
          url: stored.url,
        },
      ];
    }
    return [];
  });
  ipcMain.handle("remote-config:save", async (_event, { servers }) => {
    const list = Array.isArray(servers) ? servers : [];
    if (
      list.some((server) => server.token) &&
      !safeStorage.isEncryptionAvailable()
    ) {
      throw new Error("OS credential encryption is unavailable");
    }
    const stored = list.map((server) => ({
      encryptedToken: server.token
        ? safeStorage.encryptString(server.token).toString("base64")
        : "",
      id: server.id || crypto.randomUUID(),
      name: server.name || server.url || "",
      url: server.url || "",
    }));
    await fs.writeFile(
      remoteConfigFile,
      JSON.stringify({ servers: stored }, null, 2),
      { mode: 0o600 }
    );
    return true;
  });
  ipcMain.handle("remote-config:clear", async () => {
    await fs.rm(remoteConfigFile, { force: true });
    return true;
  });

  win.webContents.on("console-message", (event) =>
    console.log(`[renderer:${event.level}] ${event.message}`)
  );
  win.webContents.on("render-process-gone", (_event, details) =>
    console.error("Renderer process gone:", details)
  );

  if (app.isPackaged) {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  } else {
    win.loadURL("http://localhost:5188");
  }
}

app.whenReady().then(createWindow);
app.on("before-quit", async () => {
  await Promise.all(
    [...piSessions.values()].map((pending) =>
      pending.then((session) => session.dispose())
    )
  );
});
app.on("window-all-closed", () => app.quit());
