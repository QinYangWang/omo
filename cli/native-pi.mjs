import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Helpers for the `omo --native` spike.
 *
 * The native mode launches the Pi TUI that ships with the project-locked
 * `@earendil-works/pi-coding-agent` dependency instead of the simplified omo
 * TUI. Everything in this module is intentionally free of daemon and TTY
 * state so the resolution, version gate and spawn construction can be unit
 * tested without spawning a real interactive process.
 */

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_BIN_KEY = "pi";
const PI_VERSION_PATTERN = /^(\d+)\.(\d+)(?:\.|$)/;

/** Pi major/minor pinned by `packages/pi-runtime` (`0.85.0`). */
export const EXPECTED_PI_MAJOR_MINOR = "0.85";
export const EXTENSION_RELATIVE_PATH = "packages/pi-extension/index.js";
export const PI_INSTALL_HINT =
  "Run `pnpm install` in the repository root so the project-locked @earendil-works/pi-coding-agent dependency is present.";

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
      `The omo Pi extension is missing at ${extensionPath || "(unresolved path)"}. Restore ${EXTENSION_RELATIVE_PATH} and run \`pnpm install\`.`
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
 * Environment keys that are intentionally not inherited by the native Pi
 * process. `OMO_EXTENSION_EVENTS_URL` is re-added below when the operator set
 * it; `OMO_TOKEN` is the daemon credential and Pi never needs it.
 */
const NATIVE_ENV_EXCLUSIONS = new Set([
  "OMO_EXTENSION_EVENTS_URL",
  "OMO_TOKEN",
]);

/**
 * Builds the child environment. `OMO_EXTENSION_EVENTS_URL` is only forwarded
 * when the operator already set it; daemon-side ingestion of these events is
 * E1, so the spike must not invent an endpoint that does not exist yet. The
 * daemon token is deliberately stripped from the child environment.
 */
export function buildNativeEnv({ baseEnv = process.env, eventsUrl } = {}) {
  const requested = eventsUrl ?? baseEnv.OMO_EXTENSION_EVENTS_URL;
  const value = typeof requested === "string" ? requested.trim() : "";
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) => !NATIVE_ENV_EXCLUSIONS.has(key))
  );
  if (value.length > 0) {
    env.OMO_EXTENSION_EVENTS_URL = value;
  }
  return env;
}

/** Pure spawn description used by `omo --native` and by the unit tests. */
export function buildNativeSpawnConfig({
  binaryPath,
  extensionPath,
  passthroughArgs = [],
  baseEnv = process.env,
  eventsUrl,
  cwd,
} = {}) {
  return {
    args: buildNativeSpawnArgs({ extensionPath, passthroughArgs }),
    command: binaryPath,
    cwd,
    env: buildNativeEnv({ baseEnv, eventsUrl }),
  };
}
