import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Helpers for the `omo --native` spike.
 *
 * The native mode launches the Pi TUI that ships with the project-locked
 * `@earendil-works/pi-coding-agent` dependency instead of the simplified omo
 * TUI. Resolution, the version gate and spawn construction are pure and unit
 * tested without spawning anything. The foreground runner, the startup-window
 * hint, the daemon-failure wrapper and every hint string also live here so
 * `omo.mjs` stays a thin command dispatcher and tests can assert on the exact
 * failure text.
 */

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_BIN_KEY = "pi";
const PI_VERSION_PATTERN = /^(\d+)\.(\d+)(?:\.|$)/;

/** Pi major/minor pinned by `packages/pi-runtime` (`0.86.1`). */
export const EXPECTED_PI_MAJOR_MINOR = "0.86";
export const EXTENSION_RELATIVE_PATH = "packages/pi-extension/index.js";

/** Remediation shared by every missing/unreadable project-locked Pi install. */
export const PI_INSTALL_REMEDIATION =
  "Run `pnpm install` in the repository root so the project-locked @earendil-works/pi-coding-agent dependency is present.";

/**
 * Escape hatch for native-path failures the legacy omo TUI can work around:
 * a missing Pi binary or extension, version drift and a failed spawn. Daemon
 * failures use `DAEMON_SHARED_TUI_HINT` instead, because the legacy TUI talks
 * to the same daemon and switching TUIs would not help there.
 */
export const NATIVE_TUI_FALLBACK_HINT =
  "To bypass the native Pi path, run `omo --legacy-tui` (or set OMO_TUI=legacy) to launch the legacy omo TUI.";

/** Remediation plus escape hatch shared by every install/version failure. */
export const PI_INSTALL_HINT = `${PI_INSTALL_REMEDIATION} ${NATIVE_TUI_FALLBACK_HINT}`;

/**
 * Appended by the native path when the local daemon itself is unreachable.
 * The legacy TUI uses the same daemon, so `--legacy-tui` is not a workaround
 * here; the daemon's own error already suggests `omo serve`, which is never
 * repeated so the two lines do not duplicate each other.
 */
export const DAEMON_SHARED_TUI_HINT =
  "The legacy omo TUI talks to the same local omo daemon, so `omo --legacy-tui` (or OMO_TUI=legacy) cannot work around this failure.";

/**
 * Nonzero Pi exits inside this window are reported as startup failures. Later
 * exits are treated as normal quits and print nothing.
 */
export const PI_STARTUP_WINDOW_MS = 3000;

/** Absolute path of the omo Pi extension produced by E0-002. */
export function defaultExtensionPath(packageRoot = PACKAGE_ROOT) {
  return path.join(packageRoot, EXTENSION_RELATIVE_PATH);
}

/** Extracts `major.minor` from a semver string; returns null when absent. */
export function parseMajorMinor(version) {
  const match = PI_VERSION_PATTERN.exec(String(version ?? ""));
  if (!match) {
    return null;
  }
  return `${match[1]}.${match[2]}`;
}

/**
 * Spike version of the E3 compatibility gate. Pi's Extension API is locked to
 * a major/minor pair; a different line must fail loudly instead of silently
 * loading an untested extension host.
 */
export function assertSupportedPiVersion(
  version,
  expected = EXPECTED_PI_MAJOR_MINOR
) {
  if (parseMajorMinor(version) !== expected) {
    throw new Error(
      `Unsupported Pi version ${JSON.stringify(String(version ?? ""))}: omo requires Pi ${expected}.x (pinned by packages/pi-runtime). ${PI_INSTALL_HINT}`
    );
  }
  return version;
}

function toFilePath(resolved) {
  if (typeof resolved !== "string" || resolved.length === 0) {
    throw new TypeError("The Pi package resolver returned an empty specifier");
  }
  if (resolved.startsWith("file:")) {
    return fileURLToPath(resolved);
  }
  return resolved;
}

function findPackageManifest(entryPath, exists) {
  let directory = path.dirname(path.resolve(entryPath));
  while (directory !== path.dirname(directory)) {
    const manifestPath = path.join(directory, "package.json");
    if (exists(manifestPath)) {
      return { manifestPath, packageDir: directory };
    }
    directory = path.dirname(directory);
  }
  return null;
}

/**
 * Resolves the Pi CLI from the repository's own dependency graph. The package
 * entry is resolved through Node's normal module resolution anchored at
 * `cli/`, never through a PATH lookup, so a globally installed `pi` can never
 * be selected. The `bin.pi` entry and its version are read from the resolved
 * package manifest.
 */
export function resolvePiBinary({
  packageRoot = PACKAGE_ROOT,
  resolveEntry = (specifier) => import.meta.resolve(specifier),
  exists = fs.existsSync,
  readFile = fs.readFileSync,
} = {}) {
  let resolved;
  try {
    resolved = resolveEntry(PI_PACKAGE_NAME);
  } catch (error) {
    throw new Error(
      `Unable to resolve the project-locked Pi CLI (${PI_PACKAGE_NAME}) from ${packageRoot}. ${PI_INSTALL_HINT}`,
      { cause: error }
    );
  }
  const entryPath = toFilePath(resolved);
  const found = findPackageManifest(entryPath, exists);
  if (!found) {
    throw new Error(
      `Resolved ${PI_PACKAGE_NAME} entry ${entryPath} but found no package.json beside it. ${PI_INSTALL_HINT}`
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(readFile(found.manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read the project-locked Pi manifest at ${found.manifestPath}: ${error.message}. ${PI_INSTALL_HINT}`,
      { cause: error }
    );
  }
  if (manifest?.name !== PI_PACKAGE_NAME) {
    throw new Error(
      `Resolved ${PI_PACKAGE_NAME} to ${found.packageDir}, but its package.json declares ${JSON.stringify(manifest?.name ?? null)}. ${PI_INSTALL_HINT}`
    );
  }
  const binRelative = manifest.bin?.[PI_BIN_KEY];
  if (typeof binRelative !== "string" || binRelative.length === 0) {
    throw new Error(
      `The project-locked Pi package at ${found.packageDir} does not declare a \`bin.pi\` entry. ${PI_INSTALL_HINT}`
    );
  }
  const binaryPath = path.resolve(found.packageDir, binRelative);
  if (!exists(binaryPath)) {
    throw new Error(
      `The project-locked Pi CLI is missing at ${binaryPath}. ${PI_INSTALL_HINT}`
    );
  }
  assertSupportedPiVersion(manifest.version);
  return {
    binaryPath,
    packageDir: found.packageDir,
    version: String(manifest.version),
  };
}

/** Fails before spawn when the E0-002 extension entry is absent. */
export function assertExtensionExists(
  extensionPath,
  { exists = fs.existsSync } = {}
) {
  if (
    typeof extensionPath !== "string" ||
    extensionPath.length === 0 ||
    !exists(extensionPath)
  ) {
    throw new Error(
      `The omo Pi extension is missing at ${extensionPath || "(unresolved path)"}. Restore ${EXTENSION_RELATIVE_PATH} and run \`pnpm install\`. ${NATIVE_TUI_FALLBACK_HINT}`
    );
  }
  return extensionPath;
}

/** Builds the Pi argv: explicit extension load plus operator pass-through. */
export function buildNativeSpawnArgs({
  extensionPath,
  passthroughArgs = [],
} = {}) {
  return ["--extension", extensionPath, ...passthroughArgs];
}

/**
 * Endpoint kinds the native Pi TUI can talk to. The extension's private
 * channel is only reachable over a local Unix socket / Windows named pipe.
 */
const DAEMON_ENDPOINT_KINDS = new Set(["pipe", "unix"]);

/**
 * Environment keys the native Pi child must never inherit. The daemon token
 * is a credential Pi never needs; `OMO_EXTENSION_EVENTS_URL` is the retired
 * E0-004 spike channel superseded by daemon mode. `OMO_DAEMON_SOCKET` and
 * `OMO_PI_VERSION` are stripped so an operator-set override can never mask the
 * values resolved by the launcher; the resolved values are re-added below.
 */
const NATIVE_ENV_EXCLUSIONS = new Set([
  "OMO_DAEMON_SOCKET",
  "OMO_EXTENSION_EVENTS_URL",
  "OMO_PI_VERSION",
  "OMO_TOKEN",
]);

/**
 * Extracts the local socket path the extension must connect to from a daemon
 * discovery endpoint. Only `unix`/`pipe` endpoints are reachable from the
 * extension, so anything else (for example a TCP endpoint) fails before a
 * child process is spawned.
 */
export function resolveDaemonSocket(endpoint) {
  const kind = endpoint?.kind ?? endpoint?.transport;
  if (!DAEMON_ENDPOINT_KINDS.has(kind)) {
    throw new Error(
      `The native Pi TUI needs the local omo daemon over a Unix socket or Windows named pipe, but daemon discovery reported ${JSON.stringify(kind ?? null)}. Start the daemon with \`omo serve --socket <path>\` and retry. ${NATIVE_TUI_FALLBACK_HINT}`
    );
  }
  if (typeof endpoint.path !== "string" || endpoint.path.length === 0) {
    throw new Error(
      `The local omo daemon endpoint (${kind}) is missing its socket path. Restart the daemon with \`omo serve\` and retry. ${NATIVE_TUI_FALLBACK_HINT}`
    );
  }
  return endpoint.path;
}

/**
 * Builds the child environment for the native Pi TUI. The daemon wiring is
 * injected as `OMO_DAEMON_SOCKET` plus the locked `OMO_PI_VERSION`, always
 * from the launcher-resolved values rather than the inherited environment.
 */
export function buildNativeEnv({
  baseEnv = process.env,
  daemonSocket,
  piVersion,
} = {}) {
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) => !NATIVE_ENV_EXCLUSIONS.has(key))
  );
  const socket = typeof daemonSocket === "string" ? daemonSocket.trim() : "";
  const version = typeof piVersion === "string" ? piVersion.trim() : "";
  if (socket.length > 0) {
    env.OMO_DAEMON_SOCKET = socket;
  }
  if (version.length > 0) {
    env.OMO_PI_VERSION = version;
  }
  return env;
}

/** Pure spawn description used by `omo --native` and by the unit tests. */
export function buildNativeSpawnConfig({
  baseEnv = process.env,
  binaryPath,
  cwd,
  daemonSocket,
  extensionPath,
  passthroughArgs = [],
  piVersion,
} = {}) {
  return {
    args: buildNativeSpawnArgs({ extensionPath, passthroughArgs }),
    command: binaryPath,
    cwd,
    env: buildNativeEnv({ baseEnv, daemonSocket, piVersion }),
  };
}

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

/**
 * Exact stderr hint printed when the Pi child dies nonzero inside the startup
 * window. Exported so tests and docs can assert on the text.
 */
export function formatPiStartupFailureHint({ command, elapsedMs, exitCode }) {
  return `omo: the native Pi TUI (${command}) exited with code ${exitCode} after ${elapsedMs}ms, inside the ${PI_STARTUP_WINDOW_MS}ms startup window. Pi failed during startup: the extension may not have loaded, the daemon socket may be unusable, or Pi itself crashed. ${NATIVE_TUI_FALLBACK_HINT}`;
}

/**
 * Runs the native Pi TUI as the foreground process sharing the user's TTY.
 * SIGINT/SIGTERM are forwarded so `omo` never leaves an orphaned Pi behind
 * when it is signalled directly instead of through the terminal group.
 *
 * A spawn `error` rejects with the launched command, a likely cause and the
 * escape hatch. A nonzero exit inside `startupWindowMs` writes an actionable
 * hint to stderr before the exit code is returned; the exit code itself is
 * never altered, and a later quit (or a clean exit) stays silent.
 */
export function runForeground({
  args = [],
  command,
  cwd,
  env,
  now = Date.now,
  spawnProcess = spawn,
  startupWindowMs = PI_STARTUP_WINDOW_MS,
  stderr = process.stderr,
}) {
  return new Promise((resolve, reject) => {
    const startedAt = now();
    const child = spawnProcess(command, args, { cwd, env, stdio: "inherit" });
    const forward = (signal) => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill(signal);
        } catch {
          // The child exited between the liveness check and the signal.
        }
      }
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    const cleanup = () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    child.once("error", (error) => {
      cleanup();
      const invocation = [command, ...args].join(" ");
      reject(
        new Error(
          `Unable to start the native Pi TUI (${invocation}). ${error.message}. The project-locked Pi binary may be missing or not executable; rerun \`pnpm install\` in the repository root. ${NATIVE_TUI_FALLBACK_HINT}`,
          { cause: error }
        )
      );
    });
    child.once("exit", (code, signal) => {
      cleanup();
      const exitCode = signal ? (SIGNAL_EXIT_CODES[signal] ?? 1) : (code ?? 0);
      const elapsedMs = now() - startedAt;
      if (exitCode !== 0 && elapsedMs < startupWindowMs) {
        stderr.write(
          `${formatPiStartupFailureHint({ command, elapsedMs, exitCode })}\n`
        );
      }
      resolve(exitCode);
    });
  });
}

/**
 * Runs the injected daemon-discovery function and appends the "the legacy TUI
 * shares the daemon" note to any failure. The original message is preserved
 * verbatim (including its `omo serve` suggestion) and exactly one line is
 * appended, so `--legacy-tui` is correctly reported as useless here.
 */
export async function ensureLocalHostForNative(ensureLocalHost, options) {
  try {
    return await ensureLocalHost(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${DAEMON_SHARED_TUI_HINT}`, { cause: error });
  }
}
