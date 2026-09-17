import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addHostRegistryEntry,
  CredentialResolutionError,
  createEmptyHostRegistryDocument,
  findHostRegistryEntry,
  HostRegistryDocumentSchema,
  hostEndpointLabel,
  normalizeHttpHostUrl,
  parseContract,
  removeHostRegistryEntry,
  selectHostRegistryEntry,
} from "@omo/client-core";

export const HOST_REGISTRY_FILE_NAME = "host-registry.json";

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REMOTE_HOST_TRANSPORTS = new Set(["http", "https"]);

/** Resolves the client-local registry file inside the configured data dir. */
export function hostRegistryPath(dataDir) {
  return path.join(dataDir, HOST_REGISTRY_FILE_NAME);
}

/** Mirrors `server/config.cjs` so metadata commands never need a daemon. */
export function resolveDataDir(options = {}, env = process.env) {
  const explicit = options.dataDir || env.OMO_DATA_DIR;
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.resolve(env.HOME || os.homedir(), ".omo-server");
}

/**
 * Reads and validates the registry document. A missing file means "empty",
 * but a present file that is malformed or schema-invalid is a hard error:
 * the CLI never silently resets a user's Host configuration.
 */
export function readHostRegistry(dataDir) {
  const filePath = hostRegistryPath(dataDir);
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        document: createEmptyHostRegistryDocument(),
        filePath,
        status: "missing",
      };
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Host registry file is malformed at ${filePath}: ${error.message}`,
      { cause: error }
    );
  }
  try {
    return {
      document: parseContract(
        HostRegistryDocumentSchema,
        parsed,
        "HostRegistryDocument"
      ),
      filePath,
      status: "present",
    };
  } catch (error) {
    throw new Error(
      `Host registry file is invalid at ${filePath}: ${error.message}`,
      { cause: error }
    );
  }
}

/**
 * Reports whether the registry's selected entry is a remote (`http`/`https`)
 * Host. `selectUiMode` consumes this lazily so a plain `omo` with no explicit
 * selector still routes to an `omo host use` selection instead of silently
 * defaulting to the local native TUI.
 *
 * The registry is a client-side convenience, not a launch dependency: a
 * missing, unreadable, malformed or schema-invalid file, or a dangling
 * `selectedEntryId`, all resolve to "not remote" so the local TUI can start.
 */
export function selectedRegistryHostIsRemote(options = {}, env = process.env) {
  try {
    const { document } = readHostRegistry(resolveDataDir(options, env));
    const entry = document.selectedEntryId
      ? findHostRegistryEntry(document, document.selectedEntryId)
      : undefined;
    return entry ? REMOTE_HOST_TRANSPORTS.has(entry.endpoint.transport) : false;
  } catch {
    return false;
  }
}

/**
 * Validates and atomically replaces the registry file. A temporary file in
 * the same directory is renamed over the target so a reader either sees the
 * old document or the complete new one, never a partial write. Mode 0600
 * matches the daemon state file; the document never contains token material.
 */
export function writeHostRegistry(dataDir, document) {
  const validated = parseContract(
    HostRegistryDocumentSchema,
    document,
    "HostRegistryDocument"
  );
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = hostRegistryPath(dataDir);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
  return validated;
}

/** Converts an HTTP/HTTPS URL into a registry endpoint, rejecting sockets. */
export function endpointFromUrl(value) {
  const url = normalizeHttpHostUrl(value);
  return {
    transport: url.startsWith("https://") ? "https" : "http",
    url,
  };
}

/** Validates `--credential-env` and returns the persisted opaque reference. */
export function credentialRefFromEnv(envName) {
  if (typeof envName !== "string" || !ENV_NAME_PATTERN.test(envName)) {
    throw new Error(
      `Invalid credential environment variable name: ${String(envName)}`
    );
  }
  return `env:${envName}`;
}

/**
 * CLI credential adapter. `env:<NAME>` references are resolved at connection
 * time from the process environment; nothing is persisted. The resolver
 * throws `CredentialResolutionError` (never the token or the raw reference in
 * the message) when the variable is missing or empty.
 */
export function createEnvCredentialResolver(env = process.env) {
  return {
    resolve(ref) {
      if (typeof ref !== "string" || !ref.startsWith("env:")) {
        throw new CredentialResolutionError(ref);
      }
      const value = env[ref.slice(4)];
      if (typeof value !== "string" || value.length === 0) {
        throw new CredentialResolutionError(ref);
      }
      return value;
    },
  };
}

/** Human-readable, one-way listing of the registry document. */
export function formatHostRegistry(document) {
  const lines = document.entries.map((entry) => {
    const selected = document.selectedEntryId === entry.id ? "*" : " ";
    const pinned = entry.expectedHostId ?? "-";
    const credential = entry.credentialRef ?? "-";
    return `${selected} ${entry.id}\t${entry.label}\t${hostEndpointLabel(entry.endpoint)}\t${credential}\t${pinned}`;
  });
  return ["  id\tlabel\tendpoint\tcredential\tpinned-host-id", ...lines].join(
    "\n"
  );
}

function requirePositional(options, index, usage) {
  const value = options.positional?.[index];
  if (!(typeof value === "string" && value.length > 0)) {
    throw new Error(`Usage: ${usage}`);
  }
  return value;
}

/**
 * Runs one `omo host ...` subcommand. These commands only read/write registry
 * metadata: they never discover, start or connect to a Host.
 */
export function runHostCommand(command, options, dataDir) {
  const { document } = readHostRegistry(dataDir);
  if (command === "host-list") {
    if (document.entries.length === 0) {
      console.log("No Hosts configured.");
      return;
    }
    console.log(formatHostRegistry(document));
    return;
  }
  if (command === "host-add") {
    if (options.urlSource !== "cli") {
      throw new Error(
        "Usage: omo host add --name <label> --url <http(s)://...> [--credential-env <ENV_NAME>]"
      );
    }
    const name = typeof options.name === "string" ? options.name.trim() : "";
    if (!name) {
      throw new Error(
        "Usage: omo host add --name <label> --url <http(s)://...> [--credential-env <ENV_NAME>]"
      );
    }
    const endpoint = endpointFromUrl(options.url);
    const credentialRef = options.credentialEnv
      ? credentialRefFromEnv(options.credentialEnv)
      : undefined;
    const { document: next, entry } = addHostRegistryEntry(document, {
      credentialRef,
      endpoint,
      label: name,
    });
    writeHostRegistry(dataDir, next);
    console.log(
      `Added Host ${entry.id} (${hostEndpointLabel(entry.endpoint)}).`
    );
    return;
  }
  if (command === "host-remove") {
    const id = requirePositional(options, 2, "omo host remove <entryId>");
    const { document: next, entry } = removeHostRegistryEntry(document, id);
    writeHostRegistry(dataDir, next);
    console.log(`Removed Host ${entry.id}.`);
    return;
  }
  if (command === "host-use") {
    const id = requirePositional(options, 2, "omo host use <entryId|local>");
    const next =
      id === "local"
        ? selectHostRegistryEntry(document, null)
        : selectHostRegistryEntry(document, id);
    writeHostRegistry(dataDir, next);
    console.log(
      id === "local" ? "Using the local Host daemon." : `Using Host ${id}.`
    );
    return;
  }
  throw new Error("Usage: omo host <list|add|remove|use>");
}
