import { readFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

/**
 * Private daemon channel for the omo Pi extension
 * (docs/extension-daemon-hybrid.md §5).
 *
 * The extension only ever connects OUT to the daemon's local Unix socket /
 * Windows named pipe. This module never opens a listening socket, never
 * touches TLS or the public bearer token, and never crashes Pi: every
 * rejection is turned into a bounded, best-effort delivery result.
 *
 * Everything in this file is plain ESM with no dependencies and no build
 * step so it can be loaded directly by `pi --extension`.
 */

export const DAEMON_SOCKET_ENV = "OMO_DAEMON_SOCKET";
export const PI_VERSION_ENV = "OMO_PI_VERSION";
/** Pi major/minor line the extension is tested against (E0-004 pins 0.85.0). */
export const PI_PEER_VERSION = "0.85";
export const DAEMON_REQUEST_TIMEOUT_MS = 2000;
export const DAEMON_MAX_ERROR_LOGS = 3;
export const DAEMON_MAX_CONSECUTIVE_FAILURES = 3;

const VERSION_PATTERN = /^(\d+)\.(\d+)(?:\.|$)/;

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Extracts `major.minor` from a semver string; returns null when absent.
 * Mirrors `parseMajorMinor` in `cli/native-pi.mjs` so the launcher gate and
 * the extension agree on what a compatible Pi version looks like.
 */
export function parseMajorMinor(version) {
  const match = VERSION_PATTERN.exec(String(version ?? ""));
  return match ? `${match[1]}.${match[2]}` : null;
}

/**
 * Pure peer-version check. `unknown` is intentionally rejected here; callers
 * decide whether an absent `OMO_PI_VERSION` is acceptable (the launcher is the
 * real gate in E0-004, and E3 passes the value through).
 */
export function checkPiPeerVersion(version, expected = PI_PEER_VERSION) {
  const minor = parseMajorMinor(version);
  if (minor === expected) {
    return { majorMinor: minor, ok: true };
  }
  return {
    majorMinor: minor,
    ok: false,
    reason: `pi_peer_version_mismatch: expected ${expected}.x, got ${JSON.stringify(String(version ?? ""))}`,
  };
}

/** Reads the extension's own version from its `package.json`. */
export function readExtensionVersion(metaUrl = import.meta.url) {
  try {
    const manifestUrl = new URL("./package.json", metaUrl);
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(manifestUrl), "utf8")
    );
    const version = manifest?.version;
    if (typeof version === "string" && version.length > 0) {
      return version;
    }
  } catch {
    // A missing/invalid manifest must never stop the extension from loading.
  }
  return "0.0.0";
}

const sanitize = (value, seen) => {
  if (value === null) {
    return null;
  }
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") {
    return value;
  }
  if (type === "bigint") {
    return value.toString();
  }
  if (type !== "object") {
    return;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => sanitize(item, seen));
  } else if (value instanceof Error) {
    result = { message: value.message, name: value.name };
  } else if (value instanceof Date) {
    result = value.toISOString();
  } else {
    result = {};
    for (const [key, item] of Object.entries(value)) {
      const safe = sanitize(item, seen);
      if (safe !== undefined) {
        result[key] = safe;
      }
    }
  }
  seen.delete(value);
  return result;
};

/**
 * Convert an arbitrary Pi event payload into a JSON-safe value. Handles
 * BigInt, functions, Errors, Dates, `undefined` and circular references so a
 * single forwarding failure can never break the Pi event pipeline.
 */
export function toJsonSafe(value) {
  return sanitize(value, new WeakSet());
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function buildRegisterRequest({
  cwd,
  extensionVersion,
  instanceId,
  piVersion,
  sessionFile,
  sessionId,
}) {
  const body = {
    capabilities: ["events", "commands"],
    channelVersion: 1,
    extensionVersion,
    instanceId,
    piVersion,
    sessionId,
  };
  const normalizedCwd = optionalString(cwd);
  if (normalizedCwd !== undefined) {
    body.cwd = normalizedCwd;
  }
  const normalizedSessionFile = optionalString(sessionFile);
  if (normalizedSessionFile !== undefined) {
    body.sessionFile = normalizedSessionFile;
  }
  return body;
}

export function buildHeartbeatRequest({ generation, instanceId }) {
  return { generation, instanceId };
}

export function buildNativeEvent({
  event,
  nativeSequence,
  payload,
  sessionFile,
  sessionId,
  timestamp,
}) {
  const record = { event, nativeSequence, payload, sessionId, timestamp };
  const normalizedSessionFile = optionalString(sessionFile);
  if (normalizedSessionFile !== undefined) {
    record.sessionFile = normalizedSessionFile;
  }
  return record;
}

export function buildEventBatch({ events, generation, instanceId }) {
  return { events, generation, instanceId };
}

export function buildDetachRequest({ generation, instanceId, reason }) {
  const body = { generation, instanceId };
  const normalizedReason = optionalString(reason);
  if (normalizedReason !== undefined) {
    body.reason = normalizedReason;
  }
  return body;
}

const defaultLog = (message) => {
  try {
    process.stderr.write(`[omo-pi-extension] ${message}\n`);
  } catch {
    // stderr can be closed during process teardown.
  }
};

/**
 * Minimal HTTP-over-socketPath client. `http.request({ socketPath })` works
 * for both Unix domain sockets and Windows named pipes, so no platform
 * branching is required.
 */
export class DaemonChannel {
  #consecutiveFailures = 0;
  /** @type {boolean} */
  #degraded = false;
  #errorLogs = 0;
  #log;
  #maxConsecutiveFailures;
  #maxErrorLogs;
  #socketPath;
  #timeoutMs;

  constructor({
    socketPath,
    timeoutMs = DAEMON_REQUEST_TIMEOUT_MS,
    log,
    maxConsecutiveFailures = DAEMON_MAX_CONSECUTIVE_FAILURES,
    maxErrorLogs = DAEMON_MAX_ERROR_LOGS,
  } = {}) {
    if (typeof socketPath !== "string" || socketPath.length === 0) {
      throw new TypeError("DaemonChannel requires a socketPath");
    }
    this.#socketPath = socketPath;
    this.#timeoutMs = timeoutMs;
    this.#log = typeof log === "function" ? log : defaultLog;
    this.#maxConsecutiveFailures = maxConsecutiveFailures;
    this.#maxErrorLogs = maxErrorLogs;
  }

  get degraded() {
    return this.#degraded;
  }

  /** Clears the circuit breaker after a successful (re-)registration. */
  reset() {
    this.#consecutiveFailures = 0;
    this.#degraded = false;
  }

  #noteFailure() {
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures >= this.#maxConsecutiveFailures) {
      this.#degraded = true;
    }
  }

  #logError(error) {
    if (this.#errorLogs >= this.#maxErrorLogs) {
      return;
    }
    this.#errorLogs += 1;
    this.#log(`daemon channel delivery failed: ${errorMessage(error)}`);
  }

  /**
   * One request attempt. Resolves with `{ status, value }` for any HTTP
   * response and rejects only on transport/timeout errors. Callers that need
   * a response (register, heartbeat, detach) use this directly.
   */
  request(pathname, { body, credential, method = "POST", timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers = { accept: "application/json" };
      if (payload !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = String(Buffer.byteLength(payload));
      }
      if (typeof credential === "string" && credential.length > 0) {
        headers.authorization = `Bearer ${credential}`;
      }
      let settled = false;
      const finish = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        callback(value);
      };
      const req = http.request(
        { headers, method, path: pathname, socketPath: this.#socketPath },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let value;
            if (text.length > 0) {
              try {
                value = JSON.parse(text);
              } catch {
                value = undefined;
              }
            }
            finish(resolve, { status: res.statusCode ?? 0, value });
          });
          res.on("error", (error) => finish(reject, error));
        }
      );
      req.setTimeout(timeoutMs ?? this.#timeoutMs, () => {
        req.destroy(new Error("daemon request timed out"));
      });
      req.once("error", (error) => finish(reject, error));
      if (payload !== undefined) {
        req.write(payload);
      }
      req.end();
    });
  }

  async #attempt(pathname, options) {
    try {
      const response = await this.request(pathname, options);
      const delivered = response.status >= 200 && response.status < 300;
      if (delivered) {
        this.#consecutiveFailures = 0;
      } else {
        this.#noteFailure();
      }
      return {
        delivered,
        error: undefined,
        status: response.status,
        value: response.value,
      };
    } catch (error) {
      this.#noteFailure();
      return { delivered: false, error, status: 0, value: undefined };
    }
  }

  /**
   * Fire-and-forget delivery with at most one retry, mirroring the E0 spike
   * receiver semantics. Never rejects. The circuit breaker drops traffic
   * after repeated failures; `reset()` closes it again after a successful
   * re-register.
   */
  async send(pathname, options = {}) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: #degraded is flipped by #noteFailure().
    if (this.#degraded) {
      return { delivered: false, status: 0, value: undefined };
    }
    let result = await this.#attempt(pathname, options);
    if (!result.delivered) {
      // 4xx responses (e.g. a stale-generation 409) are deterministic, so
      // retrying them would only waste a request. Transport and 5xx failures
      // get the spike's single retry.
      const retryable = result.status === 0 || result.status >= 500;
      if (retryable) {
        result = await this.#attempt(pathname, options);
      }
      if (!result.delivered) {
        this.#logError(result.error ?? new Error(`HTTP ${result.status}`));
      }
    }
    return result;
  }
}
