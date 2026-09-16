import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const HOST_ENTRY = path.join(ROOT, "server", "index.cjs");
const HOST_ADDRESS = "127.0.0.1";
const HEALTH_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 100;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, HOST_ADDRESS, () => {
      const address = probe.address();
      assert.notEqual(address, null);
      assert.equal(typeof address, "object");
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

function canRebind(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(port, HOST_ADDRESS, () => probe.close(() => resolve()));
  });
}

function createLayout(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `omo-${label}-`));
  const dataDir = path.join(root, "data");
  const agentDir = path.join(root, "agent");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { agentDir, dataDir, root, workspaceDir };
}

function spawnHost({ agentDir, dataDir, port, workspaceDir }) {
  const child = spawn(process.execPath, [HOST_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      OMO_DATA_DIR: dataDir,
      OMO_HOST: HOST_ADDRESS,
      OMO_PORT: String(port),
      OMO_TOKEN: "",
      OMO_WORKSPACE_ROOTS: workspaceDir,
      PI_CODING_AGENT_DIR: agentDir,
    },
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

async function waitForHealth(baseUrl, child, logs) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Host exited before becoming healthy (code=${child.exitCode}, signal=${child.signalCode})\n${logs.join("")}`
      );
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Host startup must be polled sequentially.
      const response = await fetch(`${baseUrl}/api/v1/health`);
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Host is still starting; retry until the deadline.
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for Host health\n${logs.join("")}`);
}

function openEventStream(baseUrl) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      `${baseUrl}/api/v1/events?sessionId=lifecycle-session`,
      (response) => {
        assert.equal(response.statusCode, 200);
        response.resume();
        resolve(request);
      }
    );
    request.once("error", reject);
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

test("Host exits cleanly on SIGTERM, closing active connections and releasing its port", async () => {
  const layout = createLayout("lifecycle-sigterm");
  const port = await freePort();
  const baseUrl = `http://${HOST_ADDRESS}:${port}`;
  const { child, logs } = spawnHost({ ...layout, port });
  let eventStream;
  try {
    await waitForHealth(baseUrl, child, logs);
    // Keep a live SSE connection open so shutdown has to close active
    // HTTP connections instead of waiting for them to end on their own.
    eventStream = await openEventStream(baseUrl);

    const exited = waitForExit(child);
    child.kill("SIGTERM");
    const result = await exited;

    assert.equal(result.signal, null, logs.join(""));
    assert.equal(result.code, 0, logs.join(""));
    assert.ok(
      logs.join("").includes("omo server listening on"),
      "Host reported listening before shutdown"
    );
  } finally {
    eventStream?.destroy();
    await stopChild(child);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }

  await assert.doesNotReject(canRebind(port));
});

test("Host shutdown is idempotent and also handles SIGINT", async () => {
  const layout = createLayout("lifecycle-idempotent");
  const port = await freePort();
  const baseUrl = `http://${HOST_ADDRESS}:${port}`;
  const { child, logs } = spawnHost({ ...layout, port });
  try {
    await waitForHealth(baseUrl, child, logs);
    const exited = waitForExit(child);
    // Repeated and mixed signals must not double-close resources or crash.
    child.kill("SIGINT");
    child.kill("SIGTERM");
    const result = await exited;
    assert.equal(result.signal, null, logs.join(""));
    assert.equal(result.code, 0, logs.join(""));
  } finally {
    await stopChild(child);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }

  await assert.doesNotReject(canRebind(port));
});

test("Host startup failure exits non-zero without leaving a listener", async () => {
  const blocked = net.createServer();
  await new Promise((resolve, reject) => {
    blocked.once("error", reject);
    blocked.listen(0, HOST_ADDRESS, resolve);
  });
  const address = blocked.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const { port } = address;
  const layout = createLayout("lifecycle-failure");
  const { child, logs } = spawnHost({ ...layout, port });
  try {
    const result = await waitForExit(child);
    assert.equal(result.signal, null, logs.join(""));
    assert.notEqual(result.code, 0, logs.join(""));
  } finally {
    await stopChild(child);
    await new Promise((resolve) => blocked.close(resolve));
    fs.rmSync(layout.root, { force: true, recursive: true });
  }

  await assert.doesNotReject(canRebind(port));
});
