"use strict";

/**
 * Local daemon discovery state and startup ownership.
 *
 * `daemon.json` lives inside the resolved Host data directory and doubles as
 * the exclusive startup lock and the discovery record. The file is created
 * with an atomic hard link (falling back to an exclusive create on
 * filesystems without hard links) so a reader always sees complete JSON.
 *
 * Ownership is tracked with the owning process id plus a random token. A state
 * file whose pid is no longer alive is safe to reclaim; a live pid is never
 * disturbed and no process is ever signalled beyond the existence probe.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DAEMON_FILE_NAME = "daemon.json";
const DAEMON_SCHEMA = "omo.daemon";
const DAEMON_STATE_VERSION = 1;
const MAX_ACQUIRE_ATTEMPTS = 5;
const ACQUIRE_RETRY_MS = 25;
const MIN_TOKEN_LENGTH = 8;
const HOST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PID_PATTERN = /"pid"\s*:\s*(\d+)/;
const LINK_UNSUPPORTED = new Set([
  "EACCES",
  "EMLINK",
  "ENOSYS",
  "ENOTSUP",
  "EPERM",
  "EXDEV",
]);

class DaemonLockedError extends Error {
  constructor(dataDir, owner) {
    const suffix = owner?.pid ? ` (pid ${owner.pid})` : "";
    super(`A local omo Host is already running for ${dataDir}${suffix}`);
    this.name = "DaemonLockedError";
    this.code = "DAEMON_ALREADY_RUNNING";
    this.dataDir = dataDir;
    this.owner = owner ?? null;
  }
}

class DaemonLeaseLostError extends Error {
  constructor(filePath) {
    super(`Daemon lease at ${filePath} is no longer owned by this process`);
    this.name = "DaemonLeaseLostError";
    this.code = "DAEMON_LEASE_LOST";
    this.filePath = filePath;
  }
}

function daemonStatePath(dataDir) {
  return path.join(dataDir, DAEMON_FILE_NAME);
}

/**
 * Builds a validated TCP endpoint for the currently available Host transport.
 * `0.0.0.0`/`::` listeners are advertised through the loopback address so a
 * local client can always connect.
 */
function tcpEndpoint({ host = "127.0.0.1", port, tls = false } = {}) {
  const connectHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const scheme = tls ? "https" : "http";
  return {
    host: connectHost,
    port: Number(port),
    transport: "tcp",
    url: `${scheme}://${connectHost}:${Number(port)}`,
  };
}

function normalizeEndpoint(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { transport } = value;
  if (typeof transport !== "string" || transport.length === 0) {
    return null;
  }
  if (transport === "tcp") {
    const host = String(value.host ?? "");
    const port = Number(value.port);
    if (host.length === 0) {
      return null;
    }
    if (!(Number.isInteger(port) && port >= 1 && port <= 65_535)) {
      return null;
    }
    const url =
      typeof value.url === "string" && value.url.length > 0
        ? value.url
        : `http://${host}:${port}`;
    return { host, port, transport, url };
  }
  // Transports added later (for example unix sockets or named pipes) keep
  // their identifying address so the schema stays forward compatible.
  const endpoint = { transport };
  if (typeof value.path === "string" && value.path.length > 0) {
    endpoint.path = value.path;
  }
  if (typeof value.url === "string" && value.url.length > 0) {
    endpoint.url = value.url;
  }
  return endpoint;
}

function buildState({ token, pid, hostId, endpoint, startedAt, updatedAt }) {
  return {
    endpoint,
    hostId: hostId ?? null,
    pid,
    schema: DAEMON_SCHEMA,
    startedAt,
    token,
    updatedAt: updatedAt ?? startedAt,
    version: DAEMON_STATE_VERSION,
  };
}

function validateDaemonState(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (
    value.schema !== DAEMON_SCHEMA ||
    value.version !== DAEMON_STATE_VERSION
  ) {
    return null;
  }
  if (
    typeof value.token !== "string" ||
    value.token.length < MIN_TOKEN_LENGTH
  ) {
    return null;
  }
  if (!(Number.isInteger(value.pid) && value.pid > 0)) {
    return null;
  }
  const endpoint = normalizeEndpoint(value.endpoint);
  if (!endpoint) {
    return null;
  }
  let hostId = null;
  if (value.hostId !== null && value.hostId !== undefined) {
    if (
      typeof value.hostId !== "string" ||
      !HOST_ID_PATTERN.test(value.hostId)
    ) {
      return null;
    }
    hostId = value.hostId.toLowerCase();
  }
  if (typeof value.startedAt !== "string" || value.startedAt.length === 0) {
    return null;
  }
  const updatedAt =
    typeof value.updatedAt === "string" && value.updatedAt.length > 0
      ? value.updatedAt
      : value.startedAt;
  return buildState({
    endpoint,
    hostId,
    pid: value.pid,
    startedAt: value.startedAt,
    token: value.token,
    updatedAt,
  });
}

/**
 * Cross-platform liveness probe. Signal 0 never terminates the target; ESRCH
 * means the pid is gone and EPERM means it exists but is owned by someone
 * else, which still counts as alive.
 */
function isProcessAlive(pid) {
  if (!(Number.isInteger(pid) && pid > 0)) {
    return false;
  }
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Best-effort pid extraction from a malformed or truncated state file. */
function extractPid(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const match = PID_PATTERN.exec(raw);
  return match ? Number(match[1]) : null;
}

function inspectDaemonState(dataDir) {
  const filePath = daemonStatePath(dataDir);
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { filePath, raw: null, state: null, status: "missing" };
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { filePath, raw, state: null, status: "malformed" };
  }
  const state = validateDaemonState(parsed);
  if (!state) {
    return { filePath, raw, state: null, status: "invalid" };
  }
  return { filePath, raw, state, status: "present" };
}

/** Returns validated discovery state, or null when absent or unreadable. */
function readDaemonState(dataDir) {
  return inspectDaemonState(dataDir).state;
}

/**
 * Returns the live owner when the state file references a running process.
 * Malformed content is only considered stale when no live pid can be found,
 * so a truncated write can never be reclaimed out from under its owner.
 */
function liveOwner(inspection) {
  if (inspection.status === "present") {
    return isProcessAlive(inspection.state.pid) ? inspection.state : null;
  }
  if (inspection.status === "malformed" || inspection.status === "invalid") {
    const pid = extractPid(inspection.raw);
    if (isProcessAlive(pid)) {
      return {
        endpoint: null,
        hostId: null,
        pid,
        startedAt: null,
        token: null,
      };
    }
  }
  return null;
}

function serialize(state) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function writeAtomic(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, contents, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * Atomically claims `filePath` with `contents`. The hard link makes the claim
 * exclusive and ensures readers never observe a partially written file. The
 * exclusive-create fallback is only used on filesystems without hard links.
 */
function createExclusiveFile(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, contents, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    fs.linkSync(temporaryPath, filePath);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") {
      return false;
    }
    if (!LINK_UNSUPPORTED.has(error.code)) {
      throw error;
    }
    try {
      fs.writeFileSync(filePath, contents, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return true;
    } catch (fallbackError) {
      if (fallbackError.code === "EEXIST") {
        return false;
      }
      throw fallbackError;
    }
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

/**
 * Removes a stale state file only when its content is unchanged from the
 * inspection. If a new owner replaced the file in the meantime we leave it
 * alone and let the caller retry against the fresh owner.
 */
function removeStaleState(filePath, expectedRaw) {
  let current;
  try {
    current = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (expectedRaw !== null && current !== expectedRaw) {
    return;
  }
  fs.rmSync(filePath, { force: true });
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

class DaemonLease {
  #dataDir;
  #filePath;
  #state;
  #status = "active";
  #token;

  constructor({ dataDir, filePath, state }) {
    this.#dataDir = dataDir;
    this.#filePath = filePath;
    this.#state = state;
    this.#token = state.token;
  }

  get dataDir() {
    return this.#dataDir;
  }

  get filePath() {
    return this.#filePath;
  }

  get released() {
    return this.#status === "released";
  }

  get state() {
    return this.#state;
  }

  isOwned() {
    const inspection = inspectDaemonState(this.#dataDir);
    return (
      inspection.status === "present" && inspection.state.token === this.#token
    );
  }

  /** Merges discovery metadata that is only known after the Host starts. */
  update(patch) {
    if (this.#status === "released") {
      throw new Error("Daemon lease has already been released");
    }
    const inspection = inspectDaemonState(this.#dataDir);
    if (
      inspection.status !== "present" ||
      inspection.state.token !== this.#token
    ) {
      throw new DaemonLeaseLostError(this.#filePath);
    }
    const next = validateDaemonState({
      ...inspection.state,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    if (!next) {
      throw new Error("Refusing to persist invalid daemon state");
    }
    writeAtomic(this.#filePath, serialize(next));
    this.#state = next;
    return next;
  }

  /**
   * Removes runtime state only when this lease still owns it. Idempotent and
   * safe from `process.exit` handlers; never removes another process's state.
   */
  release() {
    if (this.#status === "released") {
      return false;
    }
    this.#status = "released";
    const inspection = inspectDaemonState(this.#dataDir);
    if (
      inspection.status !== "present" ||
      inspection.state.token !== this.#token
    ) {
      return false;
    }
    fs.rmSync(this.#filePath, { force: true });
    return true;
  }
}

/**
 * Acquires exclusive startup ownership for one Host data directory. Throws
 * DaemonLockedError when a live owner is present. Stale, malformed or
 * truncated state is reclaimed only when it references no live process.
 */
function acquireDaemonLease(options) {
  const {
    dataDir,
    endpoint,
    hostId = null,
    maxAttempts = MAX_ACQUIRE_ATTEMPTS,
    now = () => new Date(),
    pid = process.pid,
    token = crypto.randomUUID(),
  } = options ?? {};

  if (typeof dataDir !== "string" || dataDir.length === 0) {
    throw new TypeError("acquireDaemonLease requires a dataDir");
  }
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  if (!normalizedEndpoint) {
    throw new TypeError("acquireDaemonLease requires a valid endpoint");
  }
  if (hostId !== null && !HOST_ID_PATTERN.test(hostId)) {
    throw new TypeError("acquireDaemonLease received an invalid hostId");
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = daemonStatePath(dataDir);
  const startedAt = now().toISOString();
  const state = buildState({
    endpoint: normalizedEndpoint,
    hostId: hostId === null ? null : hostId.toLowerCase(),
    pid,
    startedAt,
    token,
  });
  const contents = serialize(state);

  let lastInspection = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      sleepSync(ACQUIRE_RETRY_MS);
    }
    if (createExclusiveFile(filePath, contents)) {
      return new DaemonLease({ dataDir, filePath, state });
    }
    const inspection = inspectDaemonState(dataDir);
    lastInspection = inspection;
    const owner = liveOwner(inspection);
    if (owner) {
      throw new DaemonLockedError(dataDir, owner);
    }
    removeStaleState(filePath, inspection.raw);
  }

  throw new Error(
    `Unable to acquire the omo daemon lock at ${filePath} after ${maxAttempts} attempts` +
      (lastInspection?.status ? ` (last state: ${lastInspection.status})` : "")
  );
}

module.exports = {
  acquireDaemonLease,
  DAEMON_FILE_NAME,
  DAEMON_SCHEMA,
  DAEMON_STATE_VERSION,
  DaemonLease,
  DaemonLeaseLostError,
  DaemonLockedError,
  daemonStatePath,
  inspectDaemonState,
  isProcessAlive,
  readDaemonState,
  tcpEndpoint,
  validateDaemonState,
};
