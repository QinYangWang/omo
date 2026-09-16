"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

// Linux `sun_path` is 108 bytes and macOS is 104 bytes, both including the
// terminating NUL. A conservative budget keeps generated paths portable.
const DEFAULT_MAX_UNIX_SOCKET_PATH_BYTES = 100;
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
const MAX_WINDOWS_PIPE_NAME_CHARS = 256;
const HASH_ALGORITHM = "sha256";
const HASH_LENGTH = 16;
const SOCKET_FILE_PREFIX = "host-";
const RUNTIME_DIRECTORY_NAME = "run";
const FALLBACK_DIRECTORY_PREFIX = "omo-";
// A live listener accepts the probe immediately; this bound only protects
// against a wedged peer that never answers, which is treated as still in use.
const SOCKET_PROBE_TIMEOUT_MS = 1000;
const PIPE_LEADING_SEPARATOR_PATTERN = /^[\\/]+/;
const PIPE_SEPARATOR_PATTERN = /[\\/]+/g;

const isWindowsPlatform = (platform) => platform === "win32";

/**
 * Derives a fixed-length, filesystem-safe identifier from arbitrary input.
 * The raw value never reaches the endpoint name, so separators, whitespace
 * and other shell-hostile characters cannot leak into the socket path.
 */
function localEndpointHash(value) {
  return crypto
    .createHash(HASH_ALGORITHM)
    .update(String(value))
    .digest("hex")
    .slice(0, HASH_LENGTH);
}

function normalizeScope(scope) {
  return typeof scope === "string" && scope.trim() ? scope.trim() : "default";
}

function unixSocketFileName(hash) {
  return `${SOCKET_FILE_PREFIX}${hash}.sock`;
}

/**
 * The only directories where a filesystem-managed Unix socket may live: the
 * runtime directory derived from `dataDir`, plus the controlled short-path
 * fallback under the system temp directory. `OMO_LOCAL_SOCKET` may refine the
 * file name inside one of these roots but can never escape them.
 */
function approvedUnixRoots({ dataDir, hash, tmpDir }) {
  return {
    fallbackRoot: path.join(tmpDir, `${FALLBACK_DIRECTORY_PREFIX}${hash}`),
    runtimeRoot: path.join(dataDir, RUNTIME_DIRECTORY_NAME),
  };
}

function resolveUnixRoot({ dataDir, hash, maxUnixPathBytes, tmpDir }) {
  const { fallbackRoot, runtimeRoot } = approvedUnixRoots({
    dataDir,
    hash,
    tmpDir,
  });
  const primaryPath = path.join(runtimeRoot, unixSocketFileName(hash));
  if (Buffer.byteLength(primaryPath, "utf8") <= maxUnixPathBytes) {
    return { path: primaryPath, root: runtimeRoot };
  }
  const fallbackPath = path.join(fallbackRoot, unixSocketFileName(hash));
  if (Buffer.byteLength(fallbackPath, "utf8") > maxUnixPathBytes) {
    throw new Error(
      `Unable to derive a Unix socket path shorter than ${maxUnixPathBytes} bytes; set OMO_LOCAL_SOCKET to a short path`
    );
  }
  return { path: fallbackPath, root: fallbackRoot };
}

/**
 * Maps an explicit Unix socket path onto one of the approved roots. The temp
 * fallback is only approved when the primary path is too long for `sun_path`,
 * matching where the generated endpoint would actually live. Anything else
 * fails closed here, before any directory is created or file is unlinked.
 */
function resolveManagedUnixRoot(
  explicitPath,
  { dataDir, hash, maxUnixPathBytes, tmpDir }
) {
  const { fallbackRoot, runtimeRoot } = approvedUnixRoots({
    dataDir,
    hash,
    tmpDir,
  });
  const candidateRoots = [runtimeRoot];
  const primaryPath = path.join(runtimeRoot, unixSocketFileName(hash));
  if (Buffer.byteLength(primaryPath, "utf8") > maxUnixPathBytes) {
    candidateRoots.push(fallbackRoot);
  }
  for (const root of candidateRoots) {
    if (isInside(root, explicitPath)) {
      return root;
    }
  }
  throw new Error(
    `Refusing to manage a Unix socket outside its approved runtime directory: ${explicitPath}`
  );
}

function normalizePipeName(input, hash) {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) {
    return `${WINDOWS_PIPE_PREFIX}${FALLBACK_DIRECTORY_PREFIX}${hash}`;
  }
  if (value.startsWith(WINDOWS_PIPE_PREFIX)) {
    return value;
  }
  const suffix = value
    .replace(PIPE_LEADING_SEPARATOR_PATTERN, "")
    .replace(PIPE_SEPARATOR_PATTERN, "-");
  return `${WINDOWS_PIPE_PREFIX}${suffix}`;
}

/**
 * Resolves the deterministic local transport endpoint for a Host runtime.
 *
 * - Unix: `<dataDir>/run/host-<hash>.sock`, or a hashed short path under the
 *   system temp directory when the data directory is too long for `sun_path`.
 * - Windows: `\\.\pipe\omo-<hash>`.
 *
 * `explicit` (from OMO_LOCAL_SOCKET) overrides the generated file name but on
 * Unix it must resolve inside one of the approved managed roots; any other
 * path is rejected before the filesystem is touched. All variable input is
 * hashed before use in a generated name.
 */
function resolveLocalEndpoint({
  dataDir,
  explicit = "",
  maxUnixPathBytes = DEFAULT_MAX_UNIX_SOCKET_PATH_BYTES,
  platform = process.platform,
  scope = "",
  tmpDir = os.tmpdir(),
} = {}) {
  const directory = path.resolve(String(dataDir || "."));
  const hash = localEndpointHash(`${directory}\u0000${normalizeScope(scope)}`);
  const hasExplicit =
    typeof explicit === "string" && explicit.trim().length > 0;

  if (isWindowsPlatform(platform)) {
    const pipePath = normalizePipeName(explicit, hash);
    if (pipePath.length > MAX_WINDOWS_PIPE_NAME_CHARS) {
      throw new Error(
        `Windows named pipe name exceeds ${MAX_WINDOWS_PIPE_NAME_CHARS} characters`
      );
    }
    return {
      explicit: hasExplicit,
      hash,
      kind: "pipe",
      path: pipePath,
      root: "",
    };
  }

  if (hasExplicit) {
    const explicitPath = path.resolve(explicit.trim());
    const root = resolveManagedUnixRoot(explicitPath, {
      dataDir: directory,
      hash,
      maxUnixPathBytes,
      tmpDir,
    });
    return {
      explicit: true,
      hash,
      kind: "unix",
      path: explicitPath,
      root,
    };
  }

  const { path: socketPath, root } = resolveUnixRoot({
    dataDir: directory,
    hash,
    maxUnixPathBytes,
    tmpDir,
  });
  return { explicit: false, hash, kind: "unix", path: socketPath, root };
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== "" && !(relative.startsWith("..") || path.isAbsolute(relative))
  );
}

/**
 * Refuses to touch a Unix socket unless the endpoint owns its directory.
 * This keeps stale-socket removal and shutdown cleanup from ever unlinking
 * an arbitrary path outside the configured runtime directory.
 */
function assertManagedLocalEndpoint(endpoint) {
  if (endpoint?.kind !== "unix") {
    return;
  }
  if (!(endpoint.root && isInside(endpoint.root, endpoint.path))) {
    throw new Error(
      `Refusing to manage a Unix socket outside its runtime directory: ${endpoint.path}`
    );
  }
}

function isSocketFile(target) {
  try {
    return fs.lstatSync(target).isSocket();
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Connects to a Unix socket to decide whether a listener is still bound.
 * Returns "alive" when the connection succeeds (or the probe times out),
 * "stale" only for errors that prove nothing is accepting, and "unknown" for
 * anything ambiguous. Callers must fail closed on "unknown".
 */
function probeUnixSocket(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    timer = setTimeout(() => finish("alive"), SOCKET_PROBE_TIMEOUT_MS);
    timer.unref?.();
    socket.once("connect", () => finish("alive"));
    socket.once("error", (error) => {
      if (error?.code === "ECONNREFUSED" || error?.code === "ENOENT") {
        finish("stale");
        return;
      }
      finish("unknown");
    });
  });
}

/**
 * Creates the runtime directory and clears a proven-stale Unix socket before
 * bind. A live listener is never unlinked: it fails closed with an
 * already-in-use error instead. A regular file at the same path is rejected.
 * The file identity is re-checked after the asynchronous probe so a socket
 * replaced in the meantime is left to bind, which fails safely.
 */
async function prepareLocalEndpoint(endpoint) {
  if (endpoint?.kind !== "unix") {
    return;
  }
  assertManagedLocalEndpoint(endpoint);
  fs.mkdirSync(endpoint.root, { mode: 0o700, recursive: true });
  try {
    fs.chmodSync(endpoint.root, 0o700);
  } catch {
    // Best effort: chmod is not available on every platform/filesystem.
  }

  let existing;
  try {
    existing = fs.lstatSync(endpoint.path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!existing.isSocket()) {
    throw new Error(
      `Refusing to replace a non-socket path with a Unix socket: ${endpoint.path}`
    );
  }

  const state = await probeUnixSocket(endpoint.path);
  if (state === "alive") {
    const error = new Error(
      `Refusing to replace a Unix socket that is already in use: ${endpoint.path}`
    );
    error.code = "EADDRINUSE";
    throw error;
  }
  if (state !== "stale") {
    throw new Error(
      `Refusing to remove a Unix socket that could not be proven stale: ${endpoint.path}`
    );
  }

  let current;
  try {
    current = fs.lstatSync(endpoint.path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  // A different socket now occupies the path; leave it alone and let bind
  // surface EADDRINUSE rather than unlinking a socket we do not own.
  if (
    !current.isSocket() ||
    current.dev !== existing.dev ||
    current.ino !== existing.ino
  ) {
    return;
  }
  fs.unlinkSync(endpoint.path);
}

/**
 * Restricts the bound socket to the owning user where the platform supports
 * Unix file permissions.
 */
function protectLocalEndpoint(endpoint) {
  if (endpoint?.kind !== "unix") {
    return;
  }
  try {
    fs.chmodSync(endpoint.path, 0o600);
  } catch {
    // Best effort: chmod is not available on every platform/filesystem.
  }
}

/**
 * Removes the socket file owned by this endpoint. Only a socket this process
 * successfully bound (`owned === true`) is removed, so a failed startup can
 * never unlink a listener another process still owns.
 */
function removeLocalEndpoint(endpoint) {
  if (endpoint?.kind !== "unix" || endpoint.owned !== true) {
    return false;
  }
  assertManagedLocalEndpoint(endpoint);
  if (!isSocketFile(endpoint.path)) {
    return false;
  }
  fs.unlinkSync(endpoint.path);
  return true;
}

module.exports = {
  assertManagedLocalEndpoint,
  DEFAULT_MAX_UNIX_SOCKET_PATH_BYTES,
  localEndpointHash,
  prepareLocalEndpoint,
  protectLocalEndpoint,
  removeLocalEndpoint,
  resolveLocalEndpoint,
};
