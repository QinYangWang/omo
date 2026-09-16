import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  endpointLabel,
  parseArguments,
  selectTransportMode,
} from "../cli/local-host.mjs";

const require = createRequire(import.meta.url);
const {
  daemonStatePath,
  isProcessAlive,
  readDaemonState,
} = require("../server/daemon-state.cjs");
const { resolveLocalEndpoint } = require("../server/local-endpoint.cjs");

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI_ENTRY = path.join(ROOT, "cli", "omo.mjs");
const HOST_ADDRESS = "127.0.0.1";
const CLI_TIMEOUT_MS = 90_000;
const DAEMON_STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;
const IS_WINDOWS = process.platform === "win32";
const MISSING_HOST_PATTERN = /Unable to connect to omo Host/;
const IDENTITY_MISMATCH_PATTERN = /identity mismatch/;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeLayout(label) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `omo-discovery-${label}-`)
  );
  const dataDir = path.join(root, "data");
  const agentDir = path.join(root, "agent");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { agentDir, dataDir, root, workspaceDir };
}

/**
 * Environment for a default-local CLI run. OMO_URL and OMO_LOCAL_SOCKET are
 * explicitly cleared so a developer/CI environment cannot leak an explicit
 * target into a discovery test.
 */
function cliEnv(layout, extra = {}) {
  return {
    ...process.env,
    OMO_DATA_DIR: layout.dataDir,
    OMO_LOCAL_SOCKET: "",
    OMO_TOKEN: "",
    OMO_URL: "",
    OMO_WORKSPACE_ROOTS: layout.workspaceDir,
    PI_CODING_AGENT_DIR: layout.agentDir,
    ...extra,
  };
}

function runCli(args, env, { timeoutMs = CLI_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: ${args.join(" ")}\n${stderr.join("")}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stderr: stderr.join(""),
        stdout: stdout.join(""),
      });
    });
  });
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

function waitForExit(child, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(
      () => reject(new Error("child did not exit within the timeout")),
      timeoutMs
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/** Waits for the startup metadata refresh that records the Host identity. */
async function waitForDiscoveredHostId(dataDir, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readDaemonState(dataDir);
    if (state?.hostId) {
      return state;
    }
    // biome-ignore lint/performance/noAwaitInLoops: discovery must be polled sequentially.
    await delay(POLL_INTERVAL_MS);
  }
  return null;
}

/**
 * Stops a daemon owned by the current test by its recorded pid. Clean
 * shutdown removes daemon.json; if it does not, the test still removes the
 * temporary state so nothing leaks between cases.
 */
async function stopDaemon(dataDir) {
  const state = readDaemonState(dataDir);
  if (!state) {
    return;
  }
  const { pid } = state;
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The daemon already exited between the probe and the signal.
    }
    const deadline = Date.now() + DAEMON_STOP_TIMEOUT_MS;
    while (Date.now() < deadline && readDaemonState(dataDir)) {
      // biome-ignore lint/performance/noAwaitInLoops: shutdown must be polled sequentially.
      await delay(POLL_INTERVAL_MS);
    }
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  fs.rmSync(daemonStatePath(dataDir), { force: true });
}

function readHostId(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "host.json"), "utf8"))
    .hostId;
}

function writeStaleState(dataDir, raw) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(daemonStatePath(dataDir), raw, "utf8");
}

test("transport precedence keeps explicit targets explicit", () => {
  assert.equal(selectTransportMode(parseArguments([], {})), "local");

  // CLI flags are explicit and CLI socket wins over CLI URL.
  assert.equal(
    selectTransportMode(
      parseArguments(["--url", "http://remote"], { OMO_URL: "http://env" })
    ),
    "url"
  );
  assert.equal(
    selectTransportMode(
      parseArguments(["--socket", "/tmp/a.sock"], { OMO_URL: "http://env" })
    ),
    "socket"
  );
  assert.equal(
    selectTransportMode(
      parseArguments(["--url", "http://remote", "--socket", "/tmp/a.sock"], {})
    ),
    "socket"
  );

  // CLI values override environment values, including env socket.
  assert.equal(
    selectTransportMode(
      parseArguments(["--url", "http://remote"], {
        OMO_LOCAL_SOCKET: "/tmp/a.sock",
      })
    ),
    "url"
  );

  // Environment targets are explicit too; env socket wins over env URL.
  assert.equal(
    selectTransportMode(parseArguments([], { OMO_URL: "http://env" })),
    "url"
  );
  assert.equal(
    selectTransportMode(
      parseArguments([], { OMO_LOCAL_SOCKET: "/tmp/a.sock" })
    ),
    "socket"
  );
  assert.equal(
    selectTransportMode(
      parseArguments([], {
        OMO_LOCAL_SOCKET: "/tmp/a.sock",
        OMO_URL: "http://env",
      })
    ),
    "socket"
  );
});

test("parseArguments recognizes serve and session subcommands", () => {
  assert.equal(parseArguments(["serve"], {}).command, "serve");
  assert.equal(parseArguments(["session", "list"], {}).command, "session-list");
  assert.equal(parseArguments(["session", "new"], {}).command, "session-new");
  assert.equal(parseArguments([], {}).command, "tui");
});

test("endpointLabel describes tcp, unix and pipe endpoints", () => {
  assert.equal(
    endpointLabel({ transport: "tcp", url: "http://127.0.0.1:5189" }),
    "http://127.0.0.1:5189"
  );
  assert.equal(
    endpointLabel({ path: "/tmp/x.sock", transport: "unix" }),
    "unix:/tmp/x.sock"
  );
  assert.equal(
    endpointLabel({ path: "\\\\.\\pipe\\omo-x", transport: "pipe" }),
    "pipe:\\\\.\\pipe\\omo-x"
  );
});

test("default local command auto-starts a daemon and reuses it", async () => {
  const layout = makeLayout("reuse");
  const env = cliEnv(layout);
  try {
    const first = await runCli(
      ["session", "list", "--cwd", layout.workspaceDir],
      env
    );
    assert.equal(first.code, 0, first.stderr);
    const firstState = readDaemonState(layout.dataDir);
    assert.ok(firstState, "discovery state is written");
    assert.equal(firstState.endpoint.transport, IS_WINDOWS ? "pipe" : "unix");
    assert.equal(isProcessAlive(firstState.pid), true);
    assert.equal(firstState.hostId, readHostId(layout.dataDir));

    const second = await runCli(
      ["session", "list", "--cwd", layout.workspaceDir],
      env
    );
    assert.equal(second.code, 0, second.stderr);
    const secondState = readDaemonState(layout.dataDir);
    assert.equal(secondState.pid, firstState.pid, "reuses the same daemon pid");
    assert.equal(secondState.hostId, firstState.hostId);
  } finally {
    await stopDaemon(layout.dataDir);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("concurrent cold-start commands converge on one daemon", async () => {
  const layout = makeLayout("concurrent");
  const env = cliEnv(layout);
  try {
    const [first, second] = await Promise.all([
      runCli(["session", "list", "--cwd", layout.workspaceDir], env),
      runCli(["session", "list", "--cwd", layout.workspaceDir], env),
    ]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    const state = readDaemonState(layout.dataDir);
    assert.ok(state, "a single daemon owns discovery state");
    assert.equal(isProcessAlive(state.pid), true);
    assert.equal(state.hostId, readHostId(layout.dataDir));
    if (!IS_WINDOWS) {
      const socketFiles = fs
        .readdirSync(path.join(layout.dataDir, "run"))
        .filter((name) => name.endsWith(".sock"));
      assert.equal(socketFiles.length, 1, "exactly one listener is bound");
    }
  } finally {
    await stopDaemon(layout.dataDir);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("foreground omo serve with socket transport records the deterministic endpoint", async () => {
  const layout = makeLayout("serve-socket");
  const expected = resolveLocalEndpoint({ dataDir: layout.dataDir });
  const child = spawn(process.execPath, [CLI_ENTRY, "serve"], {
    cwd: ROOT,
    env: cliEnv(layout, { OMO_TRANSPORT: "socket" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  try {
    const state = await waitForDiscoveredHostId(layout.dataDir);
    assert.ok(state, logs.join(""));
    assert.equal(state.endpoint.transport, IS_WINDOWS ? "pipe" : "unix");
    assert.equal(state.endpoint.path, expected.path);
    assert.equal(state.hostId, readHostId(layout.dataDir));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = waitForExit(child);
      child.kill("SIGTERM");
      await exited;
    }
    await stopDaemon(layout.dataDir);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("stale and malformed discovery state is reclaimed by auto-start", async () => {
  const layout = makeLayout("stale");
  const env = cliEnv(layout);
  const dead = await deadPid();
  const endpoint = resolveLocalEndpoint({ dataDir: layout.dataDir });
  const staleState = JSON.stringify({
    endpoint: {
      path: endpoint.path,
      transport: endpoint.kind === "pipe" ? "pipe" : "unix",
      url: "http://localhost",
    },
    hostId: null,
    pid: dead,
    schema: "omo.daemon",
    startedAt: new Date().toISOString(),
    token: "stale-owner-token",
    updatedAt: new Date().toISOString(),
    version: 1,
  });
  try {
    for (const raw of [
      staleState,
      `{"schema":"omo.daemon","version":1,"pid":${dead},"token":"truncated`,
    ]) {
      writeStaleState(layout.dataDir, raw);
      // biome-ignore lint/performance/noAwaitInLoops: stale cases must run sequentially.
      const result = await runCli(
        ["session", "list", "--cwd", layout.workspaceDir],
        env
      );
      assert.equal(result.code, 0, result.stderr);
      const state = readDaemonState(layout.dataDir);
      assert.ok(state);
      assert.notEqual(state.pid, dead);
      assert.equal(isProcessAlive(state.pid), true);
      await stopDaemon(layout.dataDir);
    }
  } finally {
    await stopDaemon(layout.dataDir);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("explicit remote URL failure does not create daemon state", async () => {
  const layout = makeLayout("explicit-url");
  const port = await freePort();
  const remote = `http://${HOST_ADDRESS}:${port}`;
  try {
    const viaFlag = await runCli(
      ["session", "list", "--cwd", layout.workspaceDir, "--url", remote],
      cliEnv(layout)
    );
    assert.notEqual(viaFlag.code, 0, viaFlag.stderr);
    assert.match(viaFlag.stderr, MISSING_HOST_PATTERN);
    assert.equal(readDaemonState(layout.dataDir), null);

    const viaEnv = await runCli(
      ["session", "list", "--cwd", layout.workspaceDir],
      cliEnv(layout, { OMO_URL: remote })
    );
    assert.notEqual(viaEnv.code, 0, viaEnv.stderr);
    assert.match(viaEnv.stderr, MISSING_HOST_PATTERN);
    assert.equal(readDaemonState(layout.dataDir), null);
  } finally {
    await stopDaemon(layout.dataDir);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("explicit socket failure does not auto-start a daemon", async () => {
  const layout = makeLayout("explicit-socket");
  const missing = path.join(layout.root, "missing.sock");
  try {
    const result = await runCli(
      ["session", "list", "--cwd", layout.workspaceDir, "--socket", missing],
      cliEnv(layout)
    );
    assert.notEqual(result.code, 0, result.stderr);
    assert.equal(readDaemonState(layout.dataDir), null);
  } finally {
    await stopDaemon(layout.dataDir);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("a recorded hostId mismatch is a hard error and never rewrites state", async () => {
  const layout = makeLayout("mismatch");
  const env = cliEnv(layout);
  try {
    const first = await runCli(
      ["session", "list", "--cwd", layout.workspaceDir],
      env
    );
    assert.equal(first.code, 0, first.stderr);
    const state = readDaemonState(layout.dataDir);
    assert.ok(state);
    const wrongHostId = "11111111-1111-4111-8111-111111111111";
    assert.notEqual(state.hostId, wrongHostId);
    fs.writeFileSync(
      daemonStatePath(layout.dataDir),
      JSON.stringify({ ...state, hostId: wrongHostId }),
      "utf8"
    );

    const second = await runCli(
      ["session", "list", "--cwd", layout.workspaceDir],
      env
    );
    assert.notEqual(second.code, 0, second.stderr);
    assert.match(second.stderr, IDENTITY_MISMATCH_PATTERN);
    const after = readDaemonState(layout.dataDir);
    assert.equal(
      after.hostId,
      wrongHostId,
      "mismatch must not be hidden by mutating discovery state"
    );
  } finally {
    await stopDaemon(layout.dataDir);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});
