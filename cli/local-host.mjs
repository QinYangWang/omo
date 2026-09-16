import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpHostClient } from "@omo/client-core";
import { createLocalEndpointFetch } from "./local-transport.mjs";

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL("./omo.mjs", import.meta.url));
const DEFAULT_URL = "http://127.0.0.1:5189";
const DEFAULT_START_TIMEOUT_MS = 30_000;
const RETRY_MS = 100;
const LOCAL_HTTP_BASE_URL = "http://localhost";
const TRAILING_SLASH = /\/$/;
const VALUE_OPTIONS = new Map([
  ["--cwd", "cwd"],
  ["--data-dir", "dataDir"],
  ["--host", "host"],
  ["--port", "port"],
  ["--session", "sessionPath"],
  ["--socket", "socket"],
  ["--token", "token"],
  ["--url", "url"],
]);

function markExplicitSource(options, option) {
  if (option === "socket") {
    options.socketSource = "cli";
  } else if (option === "url") {
    options.urlSource = "cli";
  }
}

function commandFromPositional(positional) {
  if (positional[0] === "serve") {
    return "serve";
  }
  if (positional[0] === "session" && positional[1] === "list") {
    return "session-list";
  }
  if (positional[0] === "session" && positional[1] === "new") {
    return "session-new";
  }
  return "tui";
}

/**
 * Parses CLI arguments and records whether the transport target came from an
 * explicit flag (`cli`), the environment (`env`) or neither (`null`). The
 * source is what lets `selectTransportMode` keep explicit targets explicit
 * instead of silently falling back to local discovery.
 */
export function parseArguments(argv, env = process.env) {
  const options = {
    command: "tui",
    cwd: process.cwd(),
    dataDir: env.OMO_DATA_DIR,
    host: env.OMO_HOST || "127.0.0.1",
    port: env.OMO_PORT || "5189",
    sessionPath: undefined,
    socket: env.OMO_LOCAL_SOCKET || "",
    socketSource: env.OMO_LOCAL_SOCKET ? "env" : null,
    token: env.OMO_TOKEN || "",
    url: env.OMO_URL || DEFAULT_URL,
    urlSource: env.OMO_URL ? "env" : null,
  };
  const positional = [];
  let pendingOption;
  for (const argument of argv) {
    if (pendingOption) {
      options[pendingOption] = argument;
      markExplicitSource(options, pendingOption);
      pendingOption = undefined;
      continue;
    }
    const option = VALUE_OPTIONS.get(argument);
    if (option) {
      pendingOption = option;
    } else if (argument !== "--") {
      positional.push(argument);
    }
  }
  if (pendingOption) {
    throw new Error(`Missing value for --${pendingOption}`);
  }
  options.url = options.url.replace(TRAILING_SLASH, "");
  options.command = commandFromPositional(positional);
  return options;
}

/**
 * Precedence, highest first:
 *
 * 1. `--socket` (CLI) — explicit local endpoint
 * 2. `--url` (CLI) — explicit Host URL
 * 3. `OMO_LOCAL_SOCKET` (env) — explicit local endpoint
 * 4. `OMO_URL` (env) — explicit Host URL
 * 5. default — discover or auto-start the deterministic local daemon
 *
 * CLI values override environment values; within one layer a local socket
 * wins over a URL. Only the `local` mode ever starts a Host.
 */
export function selectTransportMode(options) {
  if (options.socketSource === "cli") {
    return "socket";
  }
  if (options.urlSource === "cli") {
    return "url";
  }
  if (options.socketSource === "env") {
    return "socket";
  }
  if (options.urlSource === "env") {
    return "url";
  }
  return "local";
}

/** Human-readable target used in status output and errors. */
export function endpointLabel(endpoint) {
  if (endpoint.transport === "tcp") {
    return endpoint.url;
  }
  return `${endpoint.transport}:${endpoint.path}`;
}

/**
 * Builds the shared `HttpHostClient` for a discovery or explicit endpoint.
 * Unix sockets and Windows named pipes reuse `createLocalEndpointFetch`;
 * TCP keeps the platform fetch. No HTTP or SSE protocol code is duplicated.
 */
export function buildClientForEndpoint(endpoint, token) {
  if (endpoint.transport === "tcp") {
    return new HttpHostClient({ baseUrl: endpoint.url, token });
  }
  if (!(typeof endpoint.path === "string" && endpoint.path.length > 0)) {
    throw new Error(
      `Daemon discovery endpoint (${endpoint.transport}) is missing its local path`
    );
  }
  return new HttpHostClient({
    baseUrl: LOCAL_HTTP_BASE_URL,
    fetch: createLocalEndpointFetch(endpoint.path),
    token,
  });
}

/**
 * Resolves the exact data directory, workspace roots and Pi agent directory
 * the Host would use for the default local daemon. It mirrors
 * `server/config.cjs` so discovery and auto-start never disagree about where
 * `daemon.json` lives or which workspace the daemon can serve.
 */
export function resolveLocalConfig(options) {
  const config = require("../server/config.cjs");
  const { resolveLocalEndpoint } = require("../server/local-endpoint.cjs");
  const dataDir = options.dataDir
    ? path.resolve(options.dataDir)
    : config.dataDir;
  const workspaceRoots = [
    ...new Set([...config.workspaceRoots, path.resolve(options.cwd)]),
  ];
  return {
    agentDir: path.dirname(config.sessionRoot),
    dataDir,
    endpoint: resolveLocalEndpoint({ dataDir }),
    workspaceRoots,
  };
}

function assertHostIdentity(health, expectedHostId, dataDir) {
  if (expectedHostId && health.hostId !== expectedHostId) {
    throw new Error(
      `omo Host identity mismatch for ${dataDir}: daemon.json records ${expectedHostId} but the endpoint reports ${health.hostId}`
    );
  }
}

/**
 * Connects to the Host recorded in `daemon.json`. Returns null when there is
 * no live, reachable daemon so the caller can auto-start one. A recorded
 * hostId that disagrees with `/api/v1/health` is a hard error: discovery state
 * is never rewritten to hide a mismatch.
 */
async function connectToDiscoveredHost(local, token) {
  const {
    isProcessAlive,
    readDaemonState,
  } = require("../server/daemon-state.cjs");
  const state = readDaemonState(local.dataDir);
  if (!(state && isProcessAlive(state.pid))) {
    return null;
  }
  const client = buildClientForEndpoint(state.endpoint, token);
  let health;
  try {
    health = await client.health();
  } catch {
    return null;
  }
  const latest = readDaemonState(local.dataDir);
  assertHostIdentity(health, latest?.hostId ?? state.hostId, local.dataDir);
  return { client, endpoint: state.endpoint, hostId: health.hostId };
}

/**
 * Spawns the current CLI as a detached `omo serve` child. Going through the
 * CLI means the child acquires the D1-002 exclusive lease before binding, so
 * concurrent auto-starts converge on one daemon and the losers exit. The
 * deterministic socket/pipe, data/session/workspace environment and token are
 * passed explicitly; stdio is ignored so no terminal is inherited.
 */
function spawnDetachedServe(local, options) {
  const env = {
    ...process.env,
    OMO_DATA_DIR: local.dataDir,
    OMO_LOCAL_SOCKET: local.endpoint.path,
    OMO_TRANSPORT: "socket",
    OMO_WORKSPACE_ROOTS: local.workspaceRoots.join(","),
    PI_CODING_AGENT_DIR: local.agentDir,
  };
  if (options.token) {
    env.OMO_TOKEN = options.token;
  }
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, "serve", "--socket", local.endpoint.path],
    {
      cwd: PACKAGE_ROOT,
      detached: true,
      env,
      stdio: "ignore",
    }
  );
  child.unref();
  return child;
}

async function waitForLocalHost(local, token, child) {
  const timeoutMs = Number(
    process.env.OMO_START_TIMEOUT_MS || DEFAULT_START_TIMEOUT_MS
  );
  const deadline = Date.now() + timeoutMs;
  let exit = null;
  child?.once("exit", (code, signal) => {
    exit = { code, signal };
  });
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: startup must be polled sequentially.
    const connected = await connectToDiscoveredHost(local, token);
    if (connected) {
      return connected;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  const exitDetail = exit
    ? ` The spawned \`omo serve\` child exited (code=${exit.code}, signal=${exit.signal}).`
    : "";
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for the local omo Host at ${endpointLabel(local.endpoint)} (data dir ${local.dataDir}).${exitDetail} Run \`omo serve\` to see startup errors.`
  );
}

/** Default local behavior: reuse a live daemon or auto-start one. */
export async function ensureLocalHost(options) {
  const local = resolveLocalConfig(options);
  const existing = await connectToDiscoveredHost(local, options.token);
  if (existing) {
    return existing;
  }
  const child = spawnDetachedServe(local, options);
  return waitForLocalHost(local, options.token, child);
}

/** Explicit targets must never silently start or switch to another Host. */
export async function ensureExplicitHost(client, target) {
  try {
    return await client.health();
  } catch (error) {
    throw new Error(`Unable to connect to omo Host at ${target}`, {
      cause: error,
    });
  }
}
