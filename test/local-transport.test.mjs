import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalEndpointFetch } from "../cli/local-transport.mjs";
import { HttpHostClient } from "../packages/client-core/dist/index.js";

const require = createRequire(import.meta.url);
const { resolveLocalEndpoint } = require("../server/local-endpoint.cjs");

const ROOT = path.resolve(import.meta.dirname, "..");
const HOST_ENTRY = path.join(ROOT, "server", "index.cjs");
const IS_WINDOWS = process.platform === "win32";
const SKIP_WINDOWS = IS_WINDOWS
  ? "Unix domain sockets are unavailable on Windows"
  : false;
const HEALTH_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 20_000;
const ABORT_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;
const ALREADY_IN_USE_PATTERN = /already in use/;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    delay(ms).then(() => {
      throw new Error(message);
    }),
  ]);
}

function createLayout(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `omo-local-${label}-`));
  const dataDir = path.join(root, "data");
  const agentDir = path.join(root, "agent");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { agentDir, dataDir, root, workspaceDir };
}

function createSocketClient(socketPath) {
  return new HttpHostClient({
    baseUrl: "http://localhost",
    fetch: createLocalEndpointFetch(socketPath),
  });
}

function spawnSocketHost({ agentDir, dataDir, explicitSocket, workspaceDir }) {
  const env = {
    ...process.env,
    OMO_DATA_DIR: dataDir,
    OMO_LOCAL_SOCKET: explicitSocket || "",
    OMO_TOKEN: "",
    OMO_TRANSPORT: "socket",
    OMO_WORKSPACE_ROOTS: workspaceDir,
    PI_CODING_AGENT_DIR: agentDir,
  };
  const child = spawn(process.execPath, [HOST_ENTRY], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  return { child, logs };
}

function waitForExit(child, timeoutMs = EXIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error("Host did not exit within the timeout"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = waitForExit(child);
  child.kill("SIGKILL");
  await exited;
}

async function waitForHealth(client, child, logs) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Host exited before becoming healthy (code=${child.exitCode}, signal=${child.signalCode})\n${logs.join("")}`
      );
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Host startup must be polled sequentially.
      return await client.health();
    } catch {
      // Host is still starting; retry until the deadline.
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for Host health\n${logs.join("")}`);
}

test("shared HostClient serves health over a generated Unix socket and cleans it up", {
  skip: SKIP_WINDOWS,
}, async () => {
  const layout = createLayout("health");
  const endpoint = resolveLocalEndpoint({
    dataDir: layout.dataDir,
    platform: process.platform,
  });
  const { child, logs } = spawnSocketHost({
    ...layout,
    explicitSocket: "",
  });
  const client = createSocketClient(endpoint.path);
  try {
    const health = await waitForHealth(client, child, logs);
    assert.equal(health.ok, true);
    assert.ok(logs.join("").includes("omo server listening on unix:"));
    assert.ok(fs.existsSync(endpoint.path), "socket file is created");

    const exited = waitForExit(child);
    child.kill("SIGTERM");
    const result = await exited;
    assert.equal(result.signal, null, logs.join(""));
    assert.equal(result.code, 0, logs.join(""));
    assert.equal(
      fs.existsSync(endpoint.path),
      false,
      "graceful shutdown removes the socket"
    );
  } finally {
    await stopChild(child);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("Host clears a stale Unix socket and rebinds after an abrupt exit", {
  skip: SKIP_WINDOWS,
}, async () => {
  const layout = createLayout("rebind");
  const endpoint = resolveLocalEndpoint({
    dataDir: layout.dataDir,
    platform: process.platform,
  });
  const client = createSocketClient(endpoint.path);

  const first = spawnSocketHost({ ...layout, explicitSocket: "" });
  try {
    await waitForHealth(client, first.child, first.logs);
    const exited = waitForExit(first.child);
    first.child.kill("SIGKILL");
    await exited;
    assert.ok(
      fs.existsSync(endpoint.path),
      "abrupt exit leaves a stale socket for the next startup"
    );
  } finally {
    await stopChild(first.child);
  }

  const second = spawnSocketHost({ ...layout, explicitSocket: "" });
  try {
    const health = await waitForHealth(client, second.child, second.logs);
    assert.equal(health.ok, true);
  } finally {
    const exited = waitForExit(second.child);
    second.child.kill("SIGTERM");
    await exited;
    await stopChild(second.child);
    assert.equal(fs.existsSync(endpoint.path), false);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("a second Host fails closed and leaves a live Unix socket reachable", {
  skip: SKIP_WINDOWS,
}, async () => {
  const layout = createLayout("in-use");
  const endpoint = resolveLocalEndpoint({
    dataDir: layout.dataDir,
    platform: process.platform,
  });
  const client = createSocketClient(endpoint.path);
  const first = spawnSocketHost({ ...layout, explicitSocket: "" });
  try {
    await waitForHealth(client, first.child, first.logs);
    const before = fs.lstatSync(endpoint.path);

    const second = spawnSocketHost({ ...layout, explicitSocket: "" });
    try {
      const result = await waitForExit(second.child);
      assert.notEqual(result.code, 0, second.logs.join(""));
      assert.match(second.logs.join(""), ALREADY_IN_USE_PATTERN);
    } finally {
      await stopChild(second.child);
    }

    const health = await client.health();
    assert.equal(health.ok, true);
    assert.equal(fs.existsSync(endpoint.path), true);
    const after = fs.lstatSync(endpoint.path);
    assert.equal(after.ino, before.ino);
    assert.equal(after.dev, before.dev);
  } finally {
    const exited = waitForExit(first.child);
    first.child.kill("SIGTERM");
    await exited;
    await stopChild(first.child);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("local fetch streams SSE and aborting the subscription destroys the request", {
  skip: SKIP_WINDOWS,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omo-local-sse-"));
  const socketPath = path.join(root, "host.sock");
  const envelope = {
    id: "event-6",
    payload: { delta: "hello", type: "text_delta" },
    sequence: 6,
    sessionId: "session-1",
    timestamp: 1,
    type: "message_update",
  };
  const closed = Promise.withResolvers();
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/v1/events") {
      response.writeHead(404);
      response.end();
      return;
    }
    requestCount += 1;
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    });
    response.write("retry: 1000\n\n");
    const timer = setTimeout(() => {
      response.write(
        `id: ${envelope.sequence}\ndata: ${JSON.stringify(envelope)}\n\n`
      );
    }, 10);
    request.on("close", () => {
      clearTimeout(timer);
      closed.resolve();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const client = createSocketClient(socketPath);
  try {
    const received = await withTimeout(
      new Promise((resolve) => {
        let subscription;
        subscription = client.subscribeSession("session-1", 5, (event) => {
          subscription.close();
          resolve(event);
        });
      }),
      ABORT_TIMEOUT_MS,
      "timed out waiting for an SSE event"
    );
    assert.equal(received.sequence, 6);
    await withTimeout(
      closed.promise,
      ABORT_TIMEOUT_MS,
      "closing the subscription did not destroy the request"
    );
    await delay(50);
    assert.equal(requestCount, 1, "aborted subscription does not reconnect");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { force: true, recursive: true });
  }
});
