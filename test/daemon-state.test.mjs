import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  DaemonLockedError,
  acquireDaemonLease,
  daemonStatePath,
  readDaemonState,
  tcpEndpoint,
} = require("../server/daemon-state.cjs");

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI_ENTRY = path.join(ROOT, "cli", "omo.mjs");
const LEASE_FIXTURE = path.join(
  ROOT,
  "test",
  "fixtures",
  "daemon-lease-child.cjs"
);
const HOST_ADDRESS = "127.0.0.1";
const HEALTH_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 100;
const CHILD_TIMEOUT_MS = 30_000;
const ALREADY_RUNNING = /already running/i;

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function endpoint(port = 5199) {
  return tcpEndpoint({ host: HOST_ADDRESS, port });
}

function makeLayout(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `omo-daemon-${label}-`));
  const dataDir = path.join(root, "data");
  const agentDir = path.join(root, "agent");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { agentDir, dataDir, root, workspaceDir };
}

function writeState(dataDir, value) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    daemonStatePath(dataDir),
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8"
  );
}

function deadPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", () => resolve(child.pid));
  });
}

/**
 * Buffers IPC messages and child exit state so tests can wait for readiness,
 * outcomes and shutdown without racing the first message.
 */
function createChannel(child) {
  const messages = [];
  const listeners = [];
  const lifecycle = { exit: null };
  const notify = () => {
    for (const listener of [...listeners]) {
      listener();
    }
  };
  child.on("message", (message) => {
    messages.push(message);
    notify();
  });
  child.once("exit", (code, signal) => {
    lifecycle.exit = { code, signal };
    notify();
  });
  const take = (type) => {
    const index = messages.findIndex((message) => message.type === type);
    return index >= 0 ? messages.splice(index, 1)[0] : null;
  };
  const waitUntil = (predicate, timeoutMessage) =>
    new Promise((resolve, reject) => {
      const listener = () => {
        const value = predicate();
        if (!value) {
          return;
        }
        cleanup();
        resolve(value);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(timeoutMessage));
      }, CHILD_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
      listeners.push(listener);
      listener();
    });
  return {
    waitFor(type) {
      return waitUntil(() => take(type), `Timed out waiting for ${type}`);
    },
    waitForAny(types) {
      return waitUntil(
        () => {
          for (const type of types) {
            const message = take(type);
            if (message) {
              return message;
            }
          }
          return null;
        },
        `Timed out waiting for ${types.join(" or ")}`
      );
    },
    waitForExit() {
      return waitUntil(
        () => lifecycle.exit,
        "Timed out waiting for child exit"
      );
    },
  };
}

function spawnLeaseChild(dataDir) {
  return spawn(process.execPath, [LEASE_FIXTURE], {
    cwd: ROOT,
    env: {
      ...process.env,
      OMO_TEST_DATA_DIR: dataDir,
      OMO_TEST_HOLD_MS: "30000",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, HOST_ADDRESS, () => {
      const address = probe.address();
      assert.notEqual(address, null);
      assert.equal(typeof address, "object");
      probe.close(() => resolve(address.port));
    });
  });
}

function spawnServe({ agentDir, dataDir, port, workspaceDir }) {
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, "serve", "--host", HOST_ADDRESS, "--port", String(port)],
    {
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
    }
  );
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
      reject(new Error("Child did not exit within the timeout"));
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
      // biome-ignore lint/performance/noAwaitInLoops: startup must be polled sequentially
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

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = waitForExit(child);
  child.kill("SIGKILL");
  await exited;
}

test("concurrent acquisition grants exactly one lease", async () => {
  const layout = makeLayout("concurrent");
  const children = [];
  try {
    const count = 4;
    for (let index = 0; index < count; index += 1) {
      children.push(spawnLeaseChild(layout.dataDir));
    }
    const channels = children.map((child) => createChannel(child));
    await Promise.all(channels.map((channel) => channel.waitFor("ready")));
    for (const child of children) {
      child.send("go");
    }
    const outcomes = await Promise.all(
      channels.map((channel) => channel.waitForAny(["acquired", "rejected"]))
    );
    assert.equal(
      outcomes.filter((message) => message.type === "acquired").length,
      1
    );
    assert.equal(
      outcomes.filter((message) => message.type === "rejected").length,
      count - 1
    );
    assert.ok(readDaemonState(layout.dataDir), "winner persisted state");

    for (const child of children) {
      if (child.connected) {
        child.send("release");
      }
    }
    const exits = await Promise.all(
      channels.map((channel) => channel.waitForExit())
    );
    for (const exit of exits) {
      assert.equal(exit.code, 0);
    }
    assert.equal(
      readDaemonState(layout.dataDir),
      null,
      "winner release removed owned state"
    );
  } finally {
    for (const child of children) {
      child.kill("SIGKILL");
    }
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("a live owner rejects a second acquisition", () => {
  const layout = makeLayout("live-owner");
  try {
    const lease = acquireDaemonLease({
      dataDir: layout.dataDir,
      endpoint: endpoint(),
    });
    assert.throws(
      () =>
        acquireDaemonLease({
          dataDir: layout.dataDir,
          endpoint: endpoint(5200),
        }),
      (error) => {
        assert.ok(error instanceof DaemonLockedError);
        assert.equal(error.code, "DAEMON_ALREADY_RUNNING");
        assert.equal(error.owner.pid, process.pid);
        return true;
      }
    );
    assert.equal(lease.release(), true);
  } finally {
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("release only removes state owned by the lease and is idempotent", () => {
  const layout = makeLayout("release");
  try {
    const lease = acquireDaemonLease({
      dataDir: layout.dataDir,
      endpoint: endpoint(),
    });
    assert.equal(lease.isOwned(), true);
    assert.equal(lease.release(), true);
    assert.equal(lease.release(), false);
    assert.equal(readDaemonState(layout.dataDir), null);

    const second = acquireDaemonLease({
      dataDir: layout.dataDir,
      endpoint: endpoint(),
    });
    writeState(layout.dataDir, {
      ...second.state,
      token: "foreign-owner-token",
    });
    assert.equal(second.release(), false, "foreign token must survive release");
    assert.equal(readDaemonState(layout.dataDir).token, "foreign-owner-token");
    fs.rmSync(daemonStatePath(layout.dataDir), { force: true });
  } finally {
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("malformed and stale state is reclaimed only without a live owner", async () => {
  const layout = makeLayout("stale");
  const dead = await deadPid();
  try {
    writeState(
      layout.dataDir,
      `{"schema":"omo.daemon","version":1,"pid":${dead},"token":"truncated`
    );
    const truncated = acquireDaemonLease({
      dataDir: layout.dataDir,
      endpoint: endpoint(),
    });
    assert.equal(readDaemonState(layout.dataDir).pid, process.pid);
    truncated.release();

    writeState(layout.dataDir, {
      endpoint: endpoint(),
      hostId: null,
      pid: dead,
      schema: "omo.daemon",
      startedAt: new Date().toISOString(),
      token: "dead-owner-token",
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    const stale = acquireDaemonLease({
      dataDir: layout.dataDir,
      endpoint: endpoint(),
    });
    assert.equal(readDaemonState(layout.dataDir).pid, process.pid);
    stale.release();

    // Malformed content that still references a live pid is never reclaimed.
    writeState(
      layout.dataDir,
      `{"schema":"omo.daemon","version":1,"pid":${process.pid}`
    );
    assert.throws(
      () =>
        acquireDaemonLease({
          dataDir: layout.dataDir,
          endpoint: endpoint(),
        }),
      (error) => error.code === "DAEMON_ALREADY_RUNNING"
    );

    writeState(layout.dataDir, { pid: dead, schema: "other", version: 99 });
    const invalid = acquireDaemonLease({
      dataDir: layout.dataDir,
      endpoint: endpoint(),
    });
    assert.equal(invalid.isOwned(), true);
    invalid.release();
  } finally {
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("discovery state round-trips validated endpoint and hostId metadata", () => {
  const layout = makeLayout("discovery");
  try {
    const lease = acquireDaemonLease({
      dataDir: layout.dataDir,
      endpoint: endpoint(5300),
    });
    const updated = lease.update({
      endpoint: tcpEndpoint({ host: "0.0.0.0", port: 5300 }),
      hostId: "22222222-2222-4222-8222-222222222222",
    });
    assert.equal(updated.hostId, "22222222-2222-4222-8222-222222222222");
    assert.equal(updated.endpoint.host, "127.0.0.1");
    assert.equal(updated.endpoint.url, "http://127.0.0.1:5300");
    assert.deepEqual(readDaemonState(layout.dataDir), updated);

    // Invalid persisted state is not surfaced as discovery metadata.
    writeState(layout.dataDir, { pid: 1, schema: "omo.daemon", version: 1 });
    assert.equal(readDaemonState(layout.dataDir), null);
    fs.rmSync(daemonStatePath(layout.dataDir), { force: true });
  } finally {
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("omo serve rejects a duplicate start for the same data directory", async () => {
  const layout = makeLayout("serve-duplicate");
  const firstPort = await freePort();
  const secondPort = await freePort();
  const first = spawnServe({ ...layout, port: firstPort });
  let second = null;
  let firstStopped = false;
  try {
    const baseUrl = `http://${HOST_ADDRESS}:${firstPort}`;
    const health = await waitForHealth(baseUrl, first.child, first.logs);
    const state = readDaemonState(layout.dataDir);
    assert.equal(state.hostId, health.hostId);
    assert.equal(state.endpoint.port, firstPort);
    assert.equal(state.pid, first.child.pid);

    second = spawnServe({ ...layout, port: secondPort });
    const secondExit = await waitForExit(second.child);
    assert.equal(secondExit.signal, null, second.logs.join(""));
    assert.notEqual(secondExit.code, 0, second.logs.join(""));
    assert.match(second.logs.join(""), ALREADY_RUNNING);
    await assert.rejects(
      fetch(`http://${HOST_ADDRESS}:${secondPort}/api/v1/health`),
      "duplicate start must not leave a listener"
    );

    const firstExit = waitForExit(first.child);
    first.child.kill("SIGTERM");
    const result = await firstExit;
    assert.equal(result.code, 0, first.logs.join(""));
    firstStopped = true;
    assert.equal(
      readDaemonState(layout.dataDir),
      null,
      "clean shutdown removed owned daemon state"
    );
  } finally {
    await stopChild(second?.child);
    if (!firstStopped) {
      await stopChild(first.child);
    }
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});
