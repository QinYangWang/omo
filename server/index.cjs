const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { WebSocketServer } = require("ws");
const config = require("./config.cjs");
const { createWorkspaceGuard } = require("./workspace.cjs");
const { EventStore } = require("./event-store.cjs");
const { PiService } = require("./pi-service.cjs");
const { usageSnapshot } = require("./usage.cjs");
const { TerminalService } = require("./terminal-service.cjs");
const { fetchQuotas } = require("./quotas.cjs");

const workspace = createWorkspaceGuard(config.workspaceRoots);
const sessionWorkspace = createWorkspaceGuard([config.sessionRoot]);
const events = new EventStore(config.dataDir, config.eventRetention);
const pi = new PiService(events, workspace, sessionWorkspace);
const terminals = new TerminalService(workspace);
const projectsFile = path.join(config.dataDir, "projects.json");
fs.mkdir(config.dataDir, { recursive: true });

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && (config.corsOrigins.length === 0 || config.corsOrigins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
}

function authorized(req) {
  if (!config.token) return true;
  const value = req.headers.authorization || "";
  const supplied = value.startsWith("Bearer ") ? value.slice(7) : "";
  if (supplied.length !== config.token.length) return false;
  return require("node:crypto").timingSafeEqual(Buffer.from(supplied), Buffer.from(config.token));
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw Object.assign(new Error("Request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function readProjects() {
  try { return JSON.parse(await fs.readFile(projectsFile, "utf8")); } catch { return []; }
}
async function writeProjects(projects) { await fs.writeFile(projectsFile, JSON.stringify(projects, null, 2)); }
function git(args, cwd) {
  return new Promise((resolve) => execFile("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => resolve(error ? String(stderr || error.message) : stdout)));
}

function streamEvents(req, res, sessionId, after) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 1000\n\n");
  const send = (record) => res.write(`id: ${record.sequence}\nevent: message\ndata: ${JSON.stringify(record)}\n\n`);
  for (const record of events.list(sessionId, after)) send(record);
  const unsubscribe = events.subscribe(sessionId, send);
  const heartbeat = setInterval(() => res.write(`: heartbeat ${Date.now()}\n\n`), 15000);
  req.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
}

async function serveStatic(url, res) {
  let relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const target = path.resolve(config.webRoot, `.${relative}`);
  if (!target.startsWith(config.webRoot + path.sep)) return false;
  try {
    let data = await fs.readFile(target);
    if (path.extname(target) === ".html") {
      data = Buffer.from(data.toString("utf8").replace("</head>", "<script>window.__OMO_SERVER_URL__=location.origin</script></head>"));
    }
    res.writeHead(200, { "Content-Type": mime[path.extname(target)] || "application/octet-stream" });
    res.end(data); return true;
  } catch {
    if (path.extname(relative)) return false;
    try {
      const data = (await fs.readFile(path.join(config.webRoot, "index.html"), "utf8"))
        .replace("</head>", "<script>window.__OMO_SERVER_URL__=location.origin</script></head>");
      res.writeHead(200, { "Content-Type": mime[".html"] }); res.end(data); return true;
    } catch { return false; }
  }
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/v1/health") return json(res, 200, { ok: true, version: 1, capabilities: ["pi", "events", "projects", "files", "git", "providers", "terminal"] });
  if (url.pathname.startsWith("/api/") && !authorized(req)) return json(res, 401, { error: "Unauthorized" });

  try {
    if (req.method === "GET" && url.pathname === "/api/v1/projects") return json(res, 200, await readProjects());
    if (req.method === "POST" && url.pathname === "/api/v1/projects") {
      const input = await body(req); const cwd = await workspace.resolveExisting(input.cwd);
      const projects = await readProjects();
      let project = projects.find((item) => item.cwd === cwd);
      if (!project) { project = { id: crypto.randomUUID(), name: input.name || path.basename(cwd), cwd }; projects.push(project); await writeProjects(projects); }
      return json(res, 200, project);
    }
    if (req.method === "GET" && url.pathname === "/api/v1/sessions") {
      const cwd = await workspace.resolveExisting(url.searchParams.get("cwd"));
      const { SessionManager } = await pi.sdk;
      const list = (await SessionManager.list(cwd)).map((item) => ({ ...item, created: +item.created, modified: +item.modified }));
      return json(res, 200, list);
    }
    if (req.method === "GET" && url.pathname === "/api/v1/sessions/all") {
      const { SessionManager } = await pi.sdk;
      const list = (await SessionManager.listAll()).filter((item) => workspace.roots.some((root) => item.cwd && path.resolve(item.cwd).startsWith(root))).map((item) => ({ ...item, created: +item.created, modified: +item.modified }));
      return json(res, 200, list);
    }
    if (req.method === "POST" && url.pathname === "/api/v1/sessions/import") {
      const input = await body(req); const cwd = await workspace.resolveExisting(input.cwd); const sourcePath = await sessionWorkspace.resolveExisting(input.sourcePath);
      const { SessionManager } = await pi.sdk; return json(res, 200, { path: SessionManager.forkFrom(sourcePath, cwd).getSessionFile() });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/pi/open") return json(res, 200, await pi.open(await body(req)));
    if (req.method === "POST" && url.pathname === "/api/v1/pi/history") { const input = await body(req); return json(res, 200, pi.historyPage(input.sessionId, input.before)); }
    if (req.method === "GET" && url.pathname === "/api/v1/pi/models") return json(res, 200, await pi.models());
    if (req.method === "POST" && url.pathname === "/api/v1/pi/model") { const input = await body(req); await pi.setModel(input.sessionId, input.provider, input.modelId); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && url.pathname === "/api/v1/pi/thinking") { const input = await body(req); await pi.setThinking(input.sessionId, input.level); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && url.pathname === "/api/v1/pi/prompt") return json(res, 202, await pi.prompt(await body(req)));
    if (req.method === "POST" && url.pathname === "/api/v1/pi/abort") { const input = await body(req); await pi.abort(input.sessionId); return json(res, 200, { ok: true }); }
    if (req.method === "GET" && url.pathname === "/api/v1/events") return streamEvents(req, res, url.searchParams.get("sessionId"), Number(req.headers["last-event-id"] || url.searchParams.get("after") || 0));
    if (req.method === "POST" && url.pathname === "/api/v1/terminals") {
      const input = await body(req); return json(res, 200, await terminals.create(input.cwd));
    }
    const terminalTicketMatch = url.pathname.match(/^\/api\/v1\/terminals\/([^/]+)\/ticket$/);
    if (req.method === "POST" && terminalTicketMatch) {
      return json(res, 200, { ticket: terminals.issueTicket(decodeURIComponent(terminalTicketMatch[1])) });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/files") {
      const dir = await workspace.resolveExisting(url.searchParams.get("path"));
      const entries = (await fs.readdir(dir, { withFileTypes: true })).filter((item) => !item.name.startsWith(".") && item.name !== "node_modules").map((item) => ({ name: item.name, dir: item.isDirectory() })).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      return json(res, 200, entries);
    }
    if (req.method === "GET" && url.pathname === "/api/v1/files/content") {
      const file = await workspace.resolveExisting(url.searchParams.get("path")); const stat = await fs.stat(file);
      if (stat.size > 300 * 1024) throw Object.assign(new Error("File is too large"), { statusCode: 413 });
      return json(res, 200, { content: await fs.readFile(file, "utf8") });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/git/status") { const cwd = await workspace.resolveExisting(url.searchParams.get("cwd")); return json(res, 200, { output: await git(["status", "--porcelain"], cwd) }); }
    if (req.method === "GET" && url.pathname === "/api/v1/git/diff") { const cwd = await workspace.resolveExisting(url.searchParams.get("cwd")); return json(res, 200, { output: await git(["diff", "HEAD", "--", url.searchParams.get("file")], cwd) }); }
    if (req.method === "GET" && url.pathname === "/api/v1/git/branches") {
      const cwd = await workspace.resolveExisting(url.searchParams.get("cwd")); const output = await git(["branch", "--format=%(refname:short)|%(HEAD)"], cwd);
      const list = String(output).startsWith("fatal:") ? [] : String(output).split("\n").filter(Boolean).map((line) => { const [name, head] = line.split("|"); return { name, current: head === "*" }; });
      return json(res, 200, list);
    }
    if (req.method === "GET" && url.pathname === "/api/v1/providers") return json(res, 200, await pi.providers());
    if (req.method === "POST" && url.pathname === "/api/v1/providers/login") { const input = await body(req); return json(res, 200, await pi.login(input.providerId, input.type)); }
    if (req.method === "POST" && url.pathname === "/api/v1/providers/respond") { const input = await body(req); return json(res, 200, pi.respond(input.requestId, input.value)); }
    if (req.method === "POST" && url.pathname === "/api/v1/providers/cancel") { const input = await body(req); return json(res, 200, pi.cancel(input.requestId)); }
    if (req.method === "POST" && url.pathname === "/api/v1/providers/logout") { const input = await body(req); return json(res, 200, await pi.logout(input.providerId)); }
    if (req.method === "GET" && url.pathname === "/api/v1/quotas") return json(res, 200, await fetchQuotas(pi, path.dirname(config.sessionRoot), url.searchParams.get("force") === "true"));
    if (req.method === "GET" && url.pathname === "/api/v1/usage") return json(res, 200, await usageSnapshot(config.sessionRoot));
    if (req.method === "GET" && url.pathname === "/api/v1/cwd") return json(res, 200, { cwd: workspace.roots[0] });
    if (!url.pathname.startsWith("/api/") && await serveStatic(url, res)) return;
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return json(res, error.statusCode || 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const webSockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const match = url.pathname.match(/^\/api\/v1\/terminals\/([^/]+)\/stream$/);
  const terminalId = match && decodeURIComponent(match[1]);
  const ticket = url.searchParams.get("ticket");
  if (!terminalId || !ticket || !terminals.consumeTicket(ticket, terminalId)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy(); return;
  }
  webSockets.handleUpgrade(req, socket, head, (webSocket) => {
    terminals.attach(terminalId, webSocket, Number(url.searchParams.get("after") || 0));
  });
});

server.listen(config.port, config.host, () => {
  console.log(`omo server listening on http://${config.host}:${config.port}`);
  console.log(`workspace roots: ${workspace.roots.join(", ")}`);
  if (!config.token) console.warn("WARNING: OMO_TOKEN is not set; API authentication is disabled.");
});
