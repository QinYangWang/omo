"use strict";
const { readFileSync } = require("node:fs");
const fs = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { WebSocketServer } = require("ws");
const config = require("./config.cjs");
const { createWorkspaceGuard, inside } = require("./workspace.cjs");
const { EventStore } = require("./event-store.cjs");
const {
  appendExecutionStateEvent,
  ExecutionBroker,
} = require("./execution-broker.cjs");
const { ExtensionService } = require("./extension-service.cjs");
const { loadHostIdentity } = require("./host-identity.cjs");
const { createNativeEventHandler } = require("./native-events.cjs");
const {
  prepareLocalEndpoint,
  protectLocalEndpoint,
  removeLocalEndpoint,
  resolveLocalEndpoint,
} = require("./local-endpoint.cjs");
const { PiService } = require("./pi-service.cjs");
const { usageSnapshot } = require("./usage.cjs");
const {
  installPackage,
  listModels,
  listPackages,
  removePackage,
  setModelsEnabled,
} = require("./agent-config.cjs");
const { TerminalService } = require("./terminal-service.cjs");
const { fetchQuotas } = require("./quotas.cjs");
const { sessionCost, sessionMarkdown } = require("./session-metadata.cjs");
const {
  BrowserService,
  browserNavigatePattern,
  browserProxyPattern,
  browserSessionPattern,
} = require("./browser-service.cjs");

let hostId;
let workspace;
let sessionWorkspace;
let events;
let pi;
let piRuntime;
let projectService;
let terminals;
let browsers;
let projectsFile;
let server;
let webSockets;
let localEndpoint;
let extensionService;
let executionBroker;
let nativeEventHandler;

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
const terminalPattern = /^\/api\/v1\/terminals\/([^/]+)$/;
const terminalTicketPattern = /^\/api\/v1\/terminals\/([^/]+)\/ticket$/;
const terminalStreamPattern = /^\/api\/v1\/terminals\/([^/]+)\/stream$/;
const extensionPathPrefix = "/api/v1/extension/";

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
const gitErrorPrefix = /^(fatal|error)/i;

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
  // A cursor ahead of the stored tail cannot be satisfied by a delta. That
  // happens after the SQLite event log is recreated (a new event-log epoch):
  // the client's stale sequence is higher than every sequence in the new
  // log. Replaying from the beginning resyncs the client instead of silently
  // skipping every event up to the stale cursor. `after === latest` is the
  // normal tail case and still replays nothing.
  const cursor = after > events.latestSequence(sessionId) ? 0 : after;
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
  for (const record of events.list(sessionId, cursor)) {
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

function browserProxyRequest(url) {
  return browserProxyPattern.test(url.pathname);
}

function setBrowserCors(res, req) {
  const requestedHeaders = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    requestedHeaders ||
      "Authorization, Content-Type, Range, If-None-Match, If-Modified-Since"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
  );
  res.setHeader("Access-Control-Allow-Origin", "*");
}

async function browserRoutes(req, res, url) {
  if (route(req, url, "POST", "/api/v1/browser")) {
    const input = await body(req);
    json(res, 200, browsers.create(input.url));
    return true;
  }
  const navigateMatch = url.pathname.match(browserNavigatePattern);
  if (req.method === "POST" && navigateMatch) {
    const browserId = decodeURIComponent(navigateMatch[1]);
    const input = await body(req);
    json(res, 200, browsers.navigate(browserId, input.url));
    return true;
  }
  const sessionMatch = url.pathname.match(browserSessionPattern);
  if (req.method === "DELETE" && sessionMatch) {
    browsers.close(decodeURIComponent(sessionMatch[1]));
    json(res, 200, { ok: true });
    return true;
  }
  const proxyMatch = url.pathname.match(browserProxyPattern);
  if (proxyMatch) {
    setBrowserCors(res, req);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return true;
    }
    await browsers.proxy(
      req,
      res,
      decodeURIComponent(proxyMatch[1]),
      url.searchParams.get("url")
    );
    return true;
  }
  return false;
}

async function projectRoutes(req, res, url) {
  if (route(req, url, "GET", "/api/v1/projects")) {
    json(res, 200, await projectService.list());
    return true;
  }
  if (route(req, url, "POST", "/api/v1/projects")) {
    json(res, 200, await projectService.add(await body(req)));
    return true;
  }
  if (route(req, url, "GET", "/api/v1/sessions")) {
    const cwd = await workspace.resolveExisting(url.searchParams.get("cwd"));
    const list = (await piRuntime.listSessions(cwd)).map((item) => ({
      ...item,
      created: +item.created,
      modified: +item.modified,
    }));
    json(res, 200, list);
    return true;
  }
  if (route(req, url, "GET", "/api/v1/sessions/all")) {
    const list = (await piRuntime.listAllSessions())
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
    json(res, 200, {
      path: piRuntime.forkSession(sourcePath, cwd),
    });
    return true;
  }
  if (route(req, url, "POST", "/api/v1/sessions/rename")) {
    const input = await body(req);
    const sessionPath = await sessionWorkspace.resolveExisting(input.path);
    piRuntime.renameSession(sessionPath, String(input.name).trim());
    json(res, 200, { ok: true });
    return true;
  }
  if (route(req, url, "POST", "/api/v1/sessions/clone")) {
    const input = await body(req);
    const sessionPath = await sessionWorkspace.resolveExisting(input.path);
    json(res, 200, {
      path: piRuntime.cloneSession(sessionPath),
    });
    return true;
  }
  if (route(req, url, "GET", "/api/v1/sessions/context")) {
    const sessionPath = await sessionWorkspace.resolveExisting(
      url.searchParams.get("path")
    );
    json(res, 200, {
      markdown: sessionMarkdown(piRuntime.openSessionDocument(sessionPath)),
    });
    return true;
  }
  if (route(req, url, "GET", "/api/v1/sessions/details")) {
    const sessionPath = await sessionWorkspace.resolveExisting(
      url.searchParams.get("path")
    );
    const cwd = await workspace.resolveExisting(url.searchParams.get("cwd"));
    const branchOutput = String(await git(["branch", "--show-current"], cwd));
    json(res, 200, {
      branch: gitErrorPrefix.test(branchOutput) ? "" : branchOutput.trim(),
      cost: sessionCost(piRuntime.openSessionDocument(sessionPath)),
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
  if (route(req, url, "POST", "/api/v1/pi/context-usage")) {
    json(res, 200, await pi.contextUsage(await body(req)));
    return true;
  }
  if (route(req, url, "POST", "/api/v1/pi/context-details")) {
    json(res, 200, await pi.contextDetails(await body(req)));
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
  if (route(req, url, "POST", "/api/v1/pi/branch")) {
    const input = await body(req);
    json(res, 200, await pi.branch(input.sessionId, input.entryId));
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
    json(res, 200, await terminals.create(input.cwd, input.cols, input.rows));
    return true;
  }
  const terminalMatch = url.pathname.match(terminalPattern);
  if (req.method === "DELETE" && terminalMatch) {
    terminals.close(decodeURIComponent(terminalMatch[1]));
    json(res, 200, { ok: true });
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
  if (route(req, url, "POST", "/api/v1/git/branch")) {
    const input = await body(req);
    const cwd = await workspace.resolveExisting(input.cwd);
    const output = String(
      await git(["checkout", "-b", String(input.name ?? "")], cwd)
    );
    const failed = gitErrorPrefix.test(output);
    json(res, failed ? 400 : 200, { ok: !failed, output });
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
    json(res, 200, piRuntime.listSkills(path.dirname(config.sessionRoot)));
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
  if (await browserRoutes(req, res, url)) {
    return true;
  }
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

async function extensionRoutes(req, res, url) {
  if (!url.pathname.startsWith(extensionPathPrefix)) {
    return false;
  }
  if (localEndpoint && extensionService) {
    try {
      if (await extensionService.handle(req, res, url)) {
        return true;
      }
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        json(res, 500, { error: "Internal error" });
      }
      return true;
    }
  }
  json(res, 404, { error: "Not found" });
  return true;
}

/**
 * Thin seam for native-input control (design §5.2). The daemon does not embed
 * the native Pi process; ownership lives with the Extension, so a stop request
 * is a best-effort Abort dispatch through the broker. Keeping the operation on
 * a named handle makes the call site explicit and keeps the PiService free to
 * implement the headless fallback.
 */
class NativeSessionHandle {
  constructor(service) {
    this.pi = service;
  }

  stopNativeInput(sessionId) {
    return this.pi.stopNativeInput(sessionId);
  }
}

/**
 * Synchronous `onAck` handler for the private Extension channel.
 *
 * Only `rejected` acks become user-visible errors; `accepted`, `started` and
 * `completed` are lifecycle noise because the native turn events are the
 * truth (design §5). The handler resolves the owning Session from the
 * attachment that produced the ack and fails closed when that attachment is
 * no longer the current owner, so a late ack can never write to a Session
 * that has moved on. It must stay synchronous: ack response latency is
 * budget-sensitive.
 */
function handleExtensionAck({
  ack,
  attachment,
  events: eventStore,
  extensionService: ownerService,
  logger = console,
}) {
  if (ack?.status !== "rejected") {
    return;
  }
  const sessionId = attachment?.sessionId;
  if (!sessionId) {
    logger.warn("omo: rejected extension ack has no resolvable session");
    return;
  }
  const current = ownerService?.executionState(sessionId);
  if (
    current?.state !== "native-attached" ||
    current.ownerInstanceId !== ack.instanceId ||
    current.generation !== ack.generation
  ) {
    logger.warn(
      "omo: rejected extension ack for an attachment that is no longer current",
      ack.requestId
    );
    return;
  }
  eventStore.append(sessionId, {
    code: "extension_command_rejected",
    message: ack.reason ?? ack.status,
    requestId: ack.requestId,
    retryable: true,
    type: "omo_error",
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  setCors(req, res);
  const isBrowserProxy = browserProxyRequest(url);
  if (isBrowserProxy) {
    setBrowserCors(res, req);
  }
  if (req.method === "OPTIONS" && !isBrowserProxy) {
    res.writeHead(204);
    res.end();
    return;
  }
  // The private Extension channel never uses the public Bearer Token. It is
  // mounted only on the local socket/pipe listener and every route except
  // `register` authenticates with the short-lived instance credential.
  if (await extensionRoutes(req, res, url)) {
    return;
  }
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
        "browser",
      ],
      hostId,
      ok: true,
      protocolVersion: 1,
      version: 1,
    });
    return;
  }
  if (url.pathname.startsWith("/api/") && !isBrowserProxy && !authorized(req)) {
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

function createServer() {
  const { tlsCert, tlsKey } = config;
  if (!(tlsCert || tlsKey)) {
    return http.createServer(handleRequest);
  }
  if (!(tlsCert && tlsKey)) {
    throw new Error("OMO_TLS_CERT and OMO_TLS_KEY must be set together.");
  }
  try {
    return https.createServer(
      { cert: readFileSync(tlsCert), key: readFileSync(tlsKey) },
      handleRequest
    );
  } catch (error) {
    throw new Error(
      `Unable to load TLS cert/key: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

async function initializeCore() {
  const [
    { OperationLedger, ProjectService, WorkspaceService },
    { PiRuntimeAdapter },
  ] = await Promise.all([import("@omo/host-core"), import("@omo/pi-runtime")]);
  piRuntime = new PiRuntimeAdapter();
  projectService = new ProjectService(
    {
      list: readProjects,
      replace: writeProjects,
    },
    new WorkspaceService(workspace),
    () => crypto.randomUUID()
  );
  const operationLedger = new OperationLedger({
    get: (operationId) => Promise.resolve(events.requestResult(operationId)),
    putIfAbsent: (operationId, result) =>
      Promise.resolve(events.saveRequestIfAbsent(operationId, result)),
  });
  pi = new PiService(
    events,
    workspace,
    sessionWorkspace,
    piRuntime,
    operationLedger
  );
}

function handleUpgrade(req, socket, head) {
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
}

function listen(instance) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      instance.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      instance.off("error", onError);
      if (localEndpoint) {
        localEndpoint.owned = true;
        protectLocalEndpoint(localEndpoint);
      }
      resolve();
    };
    instance.once("error", onError);
    instance.once("listening", onListening);
    if (localEndpoint) {
      instance.listen(localEndpoint.path);
      return;
    }
    instance.listen(config.port, config.host);
  });
}

let hostStart;
let hostStop;
let signalHandlersInstalled = false;

function installSignalHandlers() {
  if (signalHandlersInstalled) {
    return;
  }
  signalHandlersInstalled = true;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      stopHost()
        .then(() => {
          process.exitCode = 0;
        })
        .catch((error) => {
          console.error("omo: graceful shutdown failed", error);
          process.exitCode = 1;
        });
    });
  }
}

async function initializeHost() {
  hostId = loadHostIdentity(config.dataDir);
  // Ownership transition events (design §4). Attach, detach and heartbeat
  // expiry each append exactly one `omo_execution_state` event to the
  // Session's existing Host event stream; headless creation is
  // client-initiated and emits nothing. `events` and `executionBroker` are
  // late-bound, so the closure reads them when a transition actually fires.
  const recordExecutionState = (sessionId) =>
    appendExecutionStateEvent(events, executionBroker, sessionId);
  extensionService = new ExtensionService({
    canAttach: (sessionId) =>
      executionBroker ? executionBroker.canAttach(sessionId) : { ok: true },
    heartbeatIntervalMs: config.extensionHeartbeatIntervalMs,
    heartbeatTimeoutMs: config.extensionHeartbeatTimeoutMs,
    hostId,
    onAck: (attachment, ack) =>
      handleExtensionAck({
        ack,
        attachment,
        events,
        extensionService,
      }),
    onAttach: (sessionId) => recordExecutionState(sessionId),
    onAttachConfirm: (sessionId) => executionBroker?.onAttachConfirm(sessionId),
    onDetach: (sessionId) => {
      // Drop the per-attachment command counter before the ownership
      // projection is written, so a re-attach always starts at sequence 1.
      executionBroker?.onDetach(sessionId);
      recordExecutionState(sessionId);
    },
    // Late-bound: ExtensionService is constructed before the EventStore, so
    // the closure reads the handler once `initializeHost` wires it below.
    onNativeEvent: (attachment, nativeEvent) =>
      nativeEventHandler?.handle(attachment, nativeEvent),
    sweepIntervalMs: Math.min(
      config.extensionHeartbeatIntervalMs,
      config.extensionHeartbeatTimeoutMs,
      1000
    ),
  });
  workspace = createWorkspaceGuard(config.workspaceRoots);
  sessionWorkspace = createWorkspaceGuard([config.sessionRoot]);
  events = new EventStore(config.dataDir, config.eventRetention);
  nativeEventHandler = createNativeEventHandler({ events });
  terminals = new TerminalService(workspace);
  browsers = new BrowserService();
  projectsFile = path.join(config.dataDir, "projects.json");
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    await initializeCore();
    executionBroker = new ExecutionBroker({
      extensionService,
      hasHeadlessRuntime: (sessionId) => pi.hasRuntime(sessionId),
      isHeadlessStreaming: (sessionId) => pi.isRuntimeStreaming(sessionId),
      releaseIdleRuntime: (sessionId) => pi.releaseIdleRuntime(sessionId),
    });
    pi.setExecutionBroker(executionBroker);
    if (config.transport === "socket") {
      localEndpoint = resolveLocalEndpoint({
        dataDir: config.dataDir,
        explicit: config.localSocket,
      });
      await prepareLocalEndpoint(localEndpoint);
    }
    server = createServer();
    webSockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", handleUpgrade);
    await listen(server);
  } catch (error) {
    await stopHost();
    throw error;
  }
  installSignalHandlers();
  let port;
  if (localEndpoint) {
    const scheme = localEndpoint.kind === "pipe" ? "pipe" : "unix";
    console.log(`omo server listening on ${scheme}:${localEndpoint.path}`);
  } else {
    const protocol = config.tlsCert ? "https" : "http";
    const address = server.address();
    port = address && typeof address === "object" ? address.port : config.port;
    console.log(`omo server listening on ${protocol}://${config.host}:${port}`);
  }
  console.log(`host id: ${hostId}`);
  console.log(`workspace roots: ${workspace.roots.join(", ")}`);
  if (!config.token) {
    console.warn(
      "WARNING: OMO_TOKEN is not set; API authentication is disabled."
    );
  }
  return { endpoint: localEndpoint, hostId, port, server, stopHost };
}

/**
 * Starts the single in-process Host. Repeated calls return the same start
 * promise so a process never binds more than one listener.
 */
function startHost() {
  hostStart ??= initializeHost();
  return hostStart;
}

/**
 * Stops accepting work and releases the Host resources. Safe to call more
 * than once and from signal handlers; never calls process.exit so callers
 * stay in control of the process outcome.
 */
function stopHost() {
  hostStop ??= shutdownHost();
  return hostStop;
}

async function shutdownHost() {
  if (server?.listening) {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
  }
  if (webSockets) {
    for (const client of webSockets.clients) {
      client.terminate();
    }
    await new Promise((resolve) => webSockets.close(() => resolve()));
  }
  try {
    removeLocalEndpoint(localEndpoint);
  } catch (error) {
    console.error("omo: failed to remove local socket", error);
  }
  terminals?.dispose();
  browsers?.dispose();
  executionBroker?.dispose();
  extensionService?.dispose();
  await piRuntime?.close();
  pi?.dispose();
  events?.close();
}

module.exports = {
  handleExtensionAck,
  NativeSessionHandle,
  startHost,
  stopHost,
};
