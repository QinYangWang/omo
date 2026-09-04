"use strict";
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { WebSocketServer } = require("ws");
const config = require("./config.cjs");
const { createWorkspaceGuard, inside } = require("./workspace.cjs");
const { EventStore } = require("./event-store.cjs");
const { PiService } = require("./pi-service.cjs");
const { usageSnapshot } = require("./usage.cjs");
const {
  installPackage,
  listModels,
  listPackages,
  listSkills,
  removePackage,
  setModelsEnabled,
} = require("./agent-config.cjs");
const { TerminalService } = require("./terminal-service.cjs");
const { fetchQuotas } = require("./quotas.cjs");

const workspace = createWorkspaceGuard(config.workspaceRoots);
const sessionWorkspace = createWorkspaceGuard([config.sessionRoot]);
const events = new EventStore(config.dataDir, config.eventRetention);
const pi = new PiService(events, workspace, sessionWorkspace);
const terminals = new TerminalService(workspace);
const projectsFile = path.join(config.dataDir, "projects.json");
fs.mkdir(config.dataDir, { recursive: true });

const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const imageMime = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 300 * 1024;
const MAX_IMAGE_FILE_BYTES = 5_900_000;
const terminalTicketPattern = /^\/api\/v1\/terminals\/([^/]+)\/ticket$/;
const terminalStreamPattern = /^\/api\/v1\/terminals\/([^/]+)\/stream$/;

function setCors(req, res) {
  const { origin } = req.headers;
  if (
    origin &&
    (config.corsOrigins.length === 0 || config.corsOrigins.includes(origin))
  ) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Last-Event-ID"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
}

function authorized(req) {
  if (!config.token) {
    return true;
  }
  const value = req.headers.authorization || "";
  const supplied = value.startsWith("Bearer ") ? value.slice(7) : "";
  if (supplied.length !== config.token.length) {
    return false;
  }
  return require("node:crypto").timingSafeEqual(
    Buffer.from(supplied),
    Buffer.from(config.token)
  );
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw Object.assign(new Error("Request body too large"), {
        statusCode: 413,
      });
    }
    chunks.push(chunk);
  }
  return chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
    : {};
}

async function readProjects() {
  try {
    return JSON.parse(await fs.readFile(projectsFile, "utf8"));
  } catch {
    return [];
  }
}
async function writeProjects(projects) {
  await fs.writeFile(projectsFile, JSON.stringify(projects, null, 2));
}
function git(args, cwd) {
  return new Promise((resolve) =>
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve(error ? String(stderr || error.message) : stdout)
    )
  );
}

function streamEvents(req, res, sessionId, after) {
  res.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 1000\n\n");
  const send = (record) =>
    res.write(
      `id: ${record.sequence}\nevent: message\ndata: ${JSON.stringify(record)}\n\n`
    );
  for (const record of events.list(sessionId, after)) {
    send(record);
  }
  const unsubscribe = events.subscribe(sessionId, send);
  const heartbeat = setInterval(
    () => res.write(`: heartbeat ${Date.now()}\n\n`),
    15_000
  );
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function serveStatic(url, res) {
  const relative = decodeURIComponent(
    url.pathname === "/" ? "/index.html" : url.pathname
  );
  const target = path.resolve(config.webRoot, `.${relative}`);
  if (!target.startsWith(config.webRoot + path.sep)) {
    return false;
  }
  try {
    let data = await fs.readFile(target);
    if (path.extname(target) === ".html") {
      data = Buffer.from(
        data
          .toString("utf8")
          .replace(
            "</head>",
            "<script>window.__OMO_SERVER_URL__=location.origin</script></head>"
          )
      );
    }
    res.writeHead(200, {
      "Content-Type": mime[path.extname(target)] || "application/octet-stream",
    });
    res.end(data);
    return true;
  } catch {
    if (path.extname(relative)) {
      return false;
    }
    try {
      const data = (
        await fs.readFile(path.join(config.webRoot, "index.html"), "utf8")
      ).replace(
        "</head>",
        "<script>window.__OMO_SERVER_URL__=location.origin</script></head>"
      );
      res.writeHead(200, { "Content-Type": mime[".html"] });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }
}

function route(req, url, method, pathname) {
  return req.method === method && url.pathname === pathname;
}

async function projectRoutes(req, res, url) {
  if (route(req, url, "GET", "/api/v1/projects")) {
    json(res, 200, await readProjects());
    return true;
  }
  if (route(req, url, "POST", "/api/v1/projects")) {
    const input = await body(req);
    const cwd = await workspace.resolveExisting(input.cwd);
    const projects = await readProjects();
    let project = projects.find((item) => item.cwd === cwd);
    if (!project) {
      project = {
        cwd,
        id: crypto.randomUUID(),
        name: input.name || path.basename(cwd),
      };
      projects.push(project);
      await writeProjects(projects);
    }
    json(res, 200, project);
    return true;
  }
  if (route(req, url, "GET", "/api/v1/sessions")) {
    const cwd = await workspace.resolveExisting(url.searchParams.get("cwd"));
    const { SessionManager } = await pi.sdk;
    const list = (await SessionManager.list(cwd)).map((item) => ({
      ...item,
      created: +item.created,
      modified: +item.modified,
    }));
    json(res, 200, list);
    return true;
  }
  if (route(req, url, "GET", "/api/v1/sessions/all")) {
    const { SessionManager } = await pi.sdk;
    const list = (await SessionManager.listAll())
      .filter((item) =>
        workspace.roots.some(
          (root) => item.cwd && inside(root, path.resolve(item.cwd))
        )
      )
      .map((item) => ({
        ...item,
        created: +item.created,
        modified: +item.modified,
      }));
    json(res, 200, list);
    return true;
  }
  if (route(req, url, "POST", "/api/v1/sessions/import")) {
    const input = await body(req);
    const cwd = await workspace.resolveExisting(input.cwd);
    const sourcePath = await sessionWorkspace.resolveExisting(input.sourcePath);
    const { SessionManager } = await pi.sdk;
    json(res, 200, {
      path: SessionManager.forkFrom(sourcePath, cwd).getSessionFile(),
    });
    return true;
  }
  return false;
}

async function piRoutes(req, res, url) {
  if (route(req, url, "POST", "/api/v1/pi/open")) {
    json(res, 200, await pi.open(await body(req)));
    return true;
  }
  if (route(req, url, "POST", "/api/v1/pi/history")) {
    const input = await body(req);
    json(res, 200, pi.historyPage(input.sessionId, input.before));
    return true;
  }
  if (route(req, url, "POST", "/api/v1/pi/sync")) {
    json(res, 200, await pi.sync(await body(req)));
    return true;
  }
  if (route(req, url, "GET", "/api/v1/pi/models")) {
    json(res, 200, await pi.models());
    return true;
  }
  if (route(req, url, "POST", "/api/v1/pi/commands")) {
    json(res, 200, await pi.commands(await body(req)));
    return true;
  }
  if (route(req, url, "POST", "/api/v1/pi/model")) {
    const input = await body(req);
    await pi.setModel(input.sessionId, input.provider, input.modelId);
    json(res, 200, { ok: true });
    return true;
  }
  if (route(req, url, "POST", "/api/v1/pi/thinking")) {
    const input = await body(req);
    await pi.setThinking(input.sessionId, input.level);
    json(res, 200, { ok: true });
    return true;
  }
  if (route(req, url, "POST", "/api/v1/pi/prompt")) {
    json(res, 202, await pi.prompt(await body(req)));
    return true;
  }
  if (route(req, url, "POST", "/api/v1/pi/abort")) {
    const input = await body(req);
    await pi.abort(input.sessionId);
    json(res, 200, { ok: true });
    return true;
  }
  if (route(req, url, "GET", "/api/v1/events")) {
    streamEvents(
      req,
      res,
      url.searchParams.get("sessionId"),
      Number(req.headers["last-event-id"] || url.searchParams.get("after") || 0)
    );
    return true;
  }
  return false;
}

async function terminalRoutes(req, res, url) {
  if (route(req, url, "POST", "/api/v1/terminals")) {
    const input = await body(req);
    json(res, 200, await terminals.create(input.cwd));
    return true;
  }
  const terminalTicketMatch = url.pathname.match(terminalTicketPattern);
  if (req.method === "POST" && terminalTicketMatch) {
    json(res, 200, {
      ticket: terminals.issueTicket(decodeURIComponent(terminalTicketMatch[1])),
    });
    return true;
  }
  return false;
}

async function fileRoutes(req, res, url) {
  if (route(req, url, "GET", "/api/v1/files")) {
    const dir = await workspace.resolveExisting(url.searchParams.get("path"));
    const entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter(
        (item) => !item.name.startsWith(".") && item.name !== "node_modules"
      )
      .map((item) => ({ dir: item.isDirectory(), name: item.name }))
      .sort(
        (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)
      );
    json(res, 200, entries);
    return true;
  }
  if (route(req, url, "GET", "/api/v1/files/content")) {
    const file = await workspace.resolveExisting(url.searchParams.get("path"));
    const stat = await fs.stat(file);
    const type = imageMime[path.extname(file).toLowerCase()];
    const binary = url.searchParams.get("binary") === "true";
    const maxBytes =
      binary && type ? MAX_IMAGE_FILE_BYTES : MAX_TEXT_FILE_BYTES;
    if (stat.size > maxBytes) {
      throw Object.assign(new Error("File is too large"), { statusCode: 413 });
    }
    if (binary && type) {
      json(res, 200, {
        data: (await fs.readFile(file)).toString("base64"),
        mimeType: type,
      });
      return true;
    }
    json(res, 200, { content: await fs.readFile(file, "utf8") });
    return true;
  }
  return false;
}

async function gitRoutes(req, res, url) {
  if (route(req, url, "GET", "/api/v1/git/status")) {
    const cwd = await workspace.resolveExisting(url.searchParams.get("cwd"));
    json(res, 200, { output: await git(["status", "--porcelain"], cwd) });
    return true;
  }
  if (route(req, url, "GET", "/api/v1/git/diff")) {
    const cwd = await workspace.resolveExisting(url.searchParams.get("cwd"));
    json(res, 200, {
      output: await git(
        ["diff", "HEAD", "--", url.searchParams.get("file")],
        cwd
      ),
    });
    return true;
  }
  if (route(req, url, "GET", "/api/v1/git/branches")) {
    const cwd = await workspace.resolveExisting(url.searchParams.get("cwd"));
    const output = await git(
      ["branch", "--format=%(refname:short)|%(HEAD)"],
      cwd
    );
    const list = String(output).startsWith("fatal:")
      ? []
      : String(output)
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [name, head] = line.split("|");
            return { current: head === "*", name };
          });
    json(res, 200, list);
    return true;
  }
  return false;
}

async function providerRoutes(req, res, url) {
  if (route(req, url, "GET", "/api/v1/providers")) {
    json(res, 200, await pi.providers());
    return true;
  }
  if (route(req, url, "POST", "/api/v1/providers/login")) {
    const input = await body(req);
    json(res, 200, await pi.login(input.providerId, input.type));
    return true;
  }
  if (route(req, url, "POST", "/api/v1/providers/respond")) {
    const input = await body(req);
    json(res, 200, pi.respond(input.requestId, input.value));
    return true;
  }
  if (route(req, url, "POST", "/api/v1/providers/cancel")) {
    const input = await body(req);
    json(res, 200, pi.cancel(input.requestId));
    return true;
  }
  if (route(req, url, "POST", "/api/v1/providers/logout")) {
    const input = await body(req);
    json(res, 200, await pi.logout(input.providerId));
    return true;
  }
  return false;
}

async function miscRoutes(req, res, url) {
  if (route(req, url, "GET", "/api/v1/quotas")) {
    json(
      res,
      200,
      await fetchQuotas(
        pi,
        path.dirname(config.sessionRoot),
        url.searchParams.get("force") === "true"
      )
    );
    return true;
  }
  if (route(req, url, "GET", "/api/v1/usage")) {
    json(res, 200, await usageSnapshot(config.sessionRoot));
    return true;
  }
  if (route(req, url, "GET", "/api/v1/skills")) {
    json(res, 200, await listSkills(path.dirname(config.sessionRoot)));
    return true;
  }
  if (route(req, url, "GET", "/api/v1/models")) {
    json(
      res,
      200,
      listModels(path.dirname(config.sessionRoot), await pi.models())
    );
    return true;
  }
  if (route(req, url, "POST", "/api/v1/models")) {
    const payload = await body(req);
    json(
      res,
      200,
      setModelsEnabled(
        path.dirname(config.sessionRoot),
        await pi.models(),
        payload.enabled
      )
    );
    return true;
  }
  if (route(req, url, "GET", "/api/v1/packages")) {
    json(res, 200, listPackages(path.dirname(config.sessionRoot)));
    return true;
  }
  if (route(req, url, "POST", "/api/v1/packages/install")) {
    const payload = await body(req);
    json(
      res,
      200,
      await installPackage(
        path.dirname(config.sessionRoot),
        String(payload.source || "")
      )
    );
    return true;
  }
  if (route(req, url, "POST", "/api/v1/packages/remove")) {
    const payload = await body(req);
    json(
      res,
      200,
      removePackage(
        path.dirname(config.sessionRoot),
        String(payload.source || "")
      )
    );
    return true;
  }
  if (route(req, url, "GET", "/api/v1/cwd")) {
    json(res, 200, { cwd: workspace.roots[0] });
    return true;
  }
  return false;
}

async function handleApiRequest(req, res, url) {
  if (await projectRoutes(req, res, url)) {
    return true;
  }
  if (await piRoutes(req, res, url)) {
    return true;
  }
  if (await terminalRoutes(req, res, url)) {
    return true;
  }
  if (await fileRoutes(req, res, url)) {
    return true;
  }
  if (await gitRoutes(req, res, url)) {
    return true;
  }
  if (await providerRoutes(req, res, url)) {
    return true;
  }
  return miscRoutes(req, res, url);
}

async function handleRequest(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/v1/health") {
    json(res, 200, {
      capabilities: [
        "pi",
        "events",
        "projects",
        "files",
        "git",
        "providers",
        "terminal",
      ],
      ok: true,
      version: 1,
    });
    return;
  }
  if (url.pathname.startsWith("/api/") && !authorized(req)) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }
  try {
    if (
      url.pathname.startsWith("/api/") &&
      (await handleApiRequest(req, res, url))
    ) {
      return;
    }
    if (!url.pathname.startsWith("/api/") && (await serveStatic(url, res))) {
      return;
    }
    json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    json(res, error.statusCode || 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const server = http.createServer(handleRequest);

const webSockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const match = url.pathname.match(terminalStreamPattern);
  const terminalId = match && decodeURIComponent(match[1]);
  const ticket = url.searchParams.get("ticket");
  if (!(terminalId && ticket && terminals.consumeTicket(ticket, terminalId))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  webSockets.handleUpgrade(req, socket, head, (webSocket) => {
    terminals.attach(
      terminalId,
      webSocket,
      Number(url.searchParams.get("after") || 0)
    );
  });
});

server.listen(config.port, config.host, () => {
  console.log(`omo server listening on http://${config.host}:${config.port}`);
  console.log(`workspace roots: ${workspace.roots.join(", ")}`);
  if (!config.token) {
    console.warn(
      "WARNING: OMO_TOKEN is not set; API authentication is disabled."
    );
  }
});
