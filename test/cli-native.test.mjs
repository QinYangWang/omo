import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addHostRegistryEntry,
  createEmptyHostRegistryDocument,
  selectHostRegistryEntry,
} from "@omo/client-core";
import {
  selectedRegistryHostIsRemote,
  writeHostRegistry,
} from "../cli/host-registry.mjs";
import { parseArguments } from "../cli/local-host.mjs";
import {
  assertExtensionExists,
  assertSupportedPiVersion,
  buildNativeEnv,
  buildNativeSpawnArgs,
  buildNativeSpawnConfig,
  DAEMON_SHARED_TUI_HINT,
  defaultExtensionPath,
  EXPECTED_PI_MAJOR_MINOR,
  EXTENSION_RELATIVE_PATH,
  ensureLocalHostForNative,
  formatPiStartupFailureHint,
  NATIVE_TUI_FALLBACK_HINT,
  PI_PACKAGE_NAME,
  PI_STARTUP_WINDOW_MS,
  parseMajorMinor,
  resolveDaemonSocket,
  resolvePiBinary,
  runForeground,
} from "../cli/native-pi.mjs";
import { selectUiMode, UI_MODE } from "../cli/ui-mode.mjs";
import { scrubOmoEnv } from "./spawn-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPO_NODE_MODULES = path.join(ROOT, "node_modules");
const GLOBAL_PI_PREFIX = path.join("/root", ".local", "share", "pi-node");
const UNSUPPORTED_PATTERN = /Unsupported Pi version/;
const PNPM_INSTALL_PATTERN = /pnpm install/;
const MISSING_BIN_PATTERN = /missing at .*cli\.js/;
const MISSING_BIN_KEY_PATTERN = /bin\.pi/;
const MISSING_EXTENSION_PATTERN = /extension is missing/;
const NATIVE_LOCAL_ONLY_PATTERN = /only supports the local omo daemon/;
const DAEMON_ENDPOINT_PATTERN = /Unix socket or Windows named pipe/;
const DAEMON_SOCKET_PATH_PATTERN = /missing its socket path/;
const USAGE_HEADER_PATTERN = /Usage:/;
const NATIVE_FLAG_PATTERN = /--native/;
const LEGACY_FLAG_PATTERN = /--legacy-tui/;
const NATIVE_LEGACY_CONFLICT_PATTERN = /select different local TUIs/;
const INVALID_OMO_TUI_PATTERN = /expected "native" or "legacy"/;
const REGISTRY_CONNECT_PATTERN = /Unable to connect to registry Host/;
const NATIVE_LAUNCH_PATTERN = /launching project-locked Pi/;
const VERSION_LINE_PATTERN = /0\.86/;
const PIN_LOCATION_PATTERN = /packages\/pi-runtime/;
const ESCAPE_HATCH_PATTERN = /--legacy-tui/;
const STARTUP_FAILURE_PATTERN = /failed during startup/;
const DAEMON_SHARED_PATTERN = /same local omo daemon/;
const VERSION_MISMATCH_PATTERN = /Unsupported Pi version "0\.87\.0"/;
const PI_CLI_PATH_PATTERN = /\/repo\/node_modules\/pi\/cli\.js/;
const EXIT_CODE_42_PATTERN = /code 42/;
const SPAWN_FAILURE_PATTERN = /Unable to start the native Pi TUI/;

test("parseArguments recognizes --native without disturbing other options", () => {
  const defaultOptions = parseArguments([], {});
  assert.equal(defaultOptions.native, false);

  const native = parseArguments(["--native", "--help"], {});
  assert.equal(native.native, true);
  // Unknown flags stay positional so they can be forwarded to Pi.
  assert.deepEqual(native.positional, ["--help"]);

  const withValue = parseArguments(
    ["--native", "--session", "abc", "--cwd", "/tmp/work"],
    {}
  );
  assert.equal(withValue.native, true);
  assert.equal(withValue.sessionPath, "abc");
  assert.equal(withValue.cwd, "/tmp/work");
  assert.deepEqual(withValue.positional, []);
});

test("parseMajorMinor extracts the compatibility line", () => {
  assert.equal(parseMajorMinor("0.86.1"), "0.86");
  assert.equal(parseMajorMinor("0.86"), "0.86");
  assert.equal(parseMajorMinor("0.86.1-beta.1"), "0.86");
  assert.equal(parseMajorMinor("1.2.3"), "1.2");
  assert.equal(parseMajorMinor("garbage"), null);
  assert.equal(parseMajorMinor(undefined), null);
});

test("assertSupportedPiVersion accepts the pinned line and rejects drift", () => {
  assert.equal(assertSupportedPiVersion("0.86.0"), "0.86.0");
  assert.equal(assertSupportedPiVersion("0.86.7"), "0.86.7");
  assert.throws(() => assertSupportedPiVersion("0.87.0"), UNSUPPORTED_PATTERN);
  assert.throws(() => assertSupportedPiVersion("1.0.0"), UNSUPPORTED_PATTERN);
  assert.throws(() => assertSupportedPiVersion("0.85.1"), UNSUPPORTED_PATTERN);
  assert.throws(() => assertSupportedPiVersion("nope"), UNSUPPORTED_PATTERN);
});

test("resolvePiBinary uses the project-locked dependency, not a global install", () => {
  const { binaryPath, version, packageDir } = resolvePiBinary();
  assert.equal(parseMajorMinor(version), EXPECTED_PI_MAJOR_MINOR);
  assert.equal(PI_PACKAGE_NAME, "@earendil-works/pi-coding-agent");
  assert.ok(
    packageDir.startsWith(`${REPO_NODE_MODULES}${path.sep}`),
    `package dir must live in the repo: ${packageDir}`
  );
  assert.ok(
    binaryPath.startsWith(`${REPO_NODE_MODULES}${path.sep}`),
    `binary must live in the repo: ${binaryPath}`
  );
  assert.equal(
    binaryPath.startsWith(`${GLOBAL_PI_PREFIX}${path.sep}`),
    false,
    `binary must not come from the global Pi install: ${binaryPath}`
  );
  assert.equal(path.basename(binaryPath), "cli.js");
  assert.equal(path.basename(path.dirname(path.dirname(binaryPath))), "dist");
  assert.ok(fs.existsSync(binaryPath));
});

test("resolvePiBinary reports an actionable error when the dependency is absent", () => {
  assert.throws(
    () =>
      resolvePiBinary({
        resolveEntry: () => {
          throw new Error("ERR_MODULE_NOT_FOUND");
        },
      }),
    PNPM_INSTALL_PATTERN
  );
});

test("resolvePiBinary fails loudly when the resolved bin entry is missing", () => {
  const fakeManifest = JSON.stringify({
    bin: { pi: "dist/bundle/cli.js" },
    name: PI_PACKAGE_NAME,
    version: "0.86.1",
  });
  assert.throws(
    () =>
      resolvePiBinary({
        exists: (candidate) => String(candidate).endsWith("package.json"),
        readFile: () => fakeManifest,
        resolveEntry: () =>
          "/repo/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
      }),
    MISSING_BIN_PATTERN
  );
  assert.throws(
    () =>
      resolvePiBinary({
        exists: (candidate) => String(candidate).endsWith("package.json"),
        readFile: () =>
          JSON.stringify({ name: PI_PACKAGE_NAME, version: "0.86.1" }),
        resolveEntry: () =>
          "/repo/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
      }),
    MISSING_BIN_KEY_PATTERN
  );
});

test("resolvePiBinary stops when the locked version drifts", () => {
  const fakeManifest = JSON.stringify({
    bin: { pi: "dist/bundle/cli.js" },
    name: PI_PACKAGE_NAME,
    version: "0.87.0",
  });
  assert.throws(
    () =>
      resolvePiBinary({
        exists: () => true,
        readFile: () => fakeManifest,
        resolveEntry: () =>
          "/repo/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
      }),
    UNSUPPORTED_PATTERN
  );
});

test("assertExtensionExists rejects a missing or empty extension path", () => {
  const present = "/repo/packages/pi-extension/index.js";
  assert.equal(assertExtensionExists(present, { exists: () => true }), present);
  assert.throws(
    () => assertExtensionExists(present, { exists: () => false }),
    MISSING_EXTENSION_PATTERN
  );
  assert.throws(
    () => assertExtensionExists("", { exists: () => false }),
    MISSING_EXTENSION_PATTERN
  );
  assert.equal(
    defaultExtensionPath(ROOT),
    path.join(ROOT, EXTENSION_RELATIVE_PATH)
  );
  assert.ok(fs.existsSync(defaultExtensionPath(ROOT)));
});

test("buildNativeSpawnConfig injects the resolved daemon wiring and strips inherited overrides", () => {
  const endpoint = { kind: "unix", path: "/x.sock" };
  const extensionPath = defaultExtensionPath(ROOT);
  const binaryPath = "/repo/node_modules/.pnpm/pi/dist/bundle/cli.js";
  const config = buildNativeSpawnConfig({
    baseEnv: {
      HOME: "/home/me",
      OMO_DAEMON_SOCKET: "/poison.sock",
      OMO_EXTENSION_EVENTS_URL: "http://127.0.0.1:1234/events",
      OMO_PI_VERSION: "9.9.9",
      OMO_TOKEN: "super-secret",
    },
    binaryPath,
    cwd: "/tmp/work",
    daemonSocket: resolveDaemonSocket(endpoint),
    extensionPath,
    passthroughArgs: ["--help"],
    piVersion: "0.86.1",
  });
  assert.equal(config.command, binaryPath);
  assert.equal(config.cwd, "/tmp/work");
  assert.deepEqual(config.args, ["--extension", extensionPath, "--help"]);
  assert.equal(config.env.OMO_DAEMON_SOCKET, "/x.sock");
  assert.equal(config.env.OMO_PI_VERSION, "0.86.1");
  assert.equal(config.env.HOME, "/home/me");
  // The retired spike channel and every inherited daemon override are gone.
  assert.equal("OMO_EXTENSION_EVENTS_URL" in config.env, false);
  assert.equal("OMO_TOKEN" in config.env, false);
  const serialized = JSON.stringify(config.env);
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("/poison.sock"), false);
  assert.equal(serialized.includes("9.9.9"), false);

  // A base env without daemon wiring stays unset instead of gaining keys.
  const bare = buildNativeEnv({ baseEnv: { HOME: "/home/me" } });
  assert.equal("OMO_DAEMON_SOCKET" in bare, false);
  assert.equal("OMO_PI_VERSION" in bare, false);
});

test("resolveDaemonSocket accepts unix/pipe endpoints and rejects other kinds", () => {
  assert.equal(
    resolveDaemonSocket({ kind: "unix", path: "/x.sock" }),
    "/x.sock"
  );
  assert.equal(
    resolveDaemonSocket({ path: "\\\\.\\pipe\\omo", transport: "pipe" }),
    "\\\\.\\pipe\\omo"
  );
  assert.throws(
    () =>
      resolveDaemonSocket({ transport: "tcp", url: "http://127.0.0.1:5189" }),
    DAEMON_ENDPOINT_PATTERN
  );
  assert.throws(
    () => resolveDaemonSocket({ kind: "unix" }),
    DAEMON_SOCKET_PATH_PATTERN
  );
  assert.throws(() => resolveDaemonSocket(null), DAEMON_ENDPOINT_PATTERN);
  // A reachable TCP daemon is a native-only limitation: the legacy TUI can
  // still talk to it, so the escape hatch points at `--legacy-tui`.
  assert.match(
    captureErrorMessage(() =>
      resolveDaemonSocket({ transport: "tcp", url: "http://127.0.0.1:5189" })
    ),
    ESCAPE_HATCH_PATTERN
  );
  assert.match(
    captureErrorMessage(() => resolveDaemonSocket({ kind: "unix" })),
    ESCAPE_HATCH_PATTERN
  );
});

test("selectUiMode defaults the local flow to the native Pi TUI", () => {
  assert.equal(selectUiMode(parseArguments([], {})), UI_MODE.native);
  assert.equal(selectUiMode(parseArguments(["--native"], {})), UI_MODE.native);

  // Explicit remote selectors always keep the legacy omo TUI.
  const remotes = [
    parseArguments(["--url", "http://host:5189"], {}),
    parseArguments(["--socket", "/tmp/omo.sock"], {}),
    parseArguments(["--server", "remote"], {}),
    parseArguments([], { OMO_URL: "http://host:5189" }),
    parseArguments([], { OMO_LOCAL_SOCKET: "/tmp/omo.sock" }),
  ];
  for (const options of remotes) {
    assert.equal(selectUiMode(options), UI_MODE.legacy);
  }

  // `--native` cannot front a remote Host.
  assert.throws(
    () =>
      selectUiMode(
        parseArguments(["--native", "--url", "http://host:5189"], {})
      ),
    NATIVE_LOCAL_ONLY_PATTERN
  );
  assert.throws(
    () => selectUiMode(parseArguments(["--native", "--server", "remote"], {})),
    NATIVE_LOCAL_ONLY_PATTERN
  );
});

test("selectUiMode honors --legacy-tui and OMO_TUI with flags beating the env", () => {
  const legacyFlag = parseArguments(["--legacy-tui"], {});
  assert.equal(legacyFlag.legacyTui, true);
  assert.equal(legacyFlag.native, false);
  assert.deepEqual(legacyFlag.positional, []);
  assert.equal(selectUiMode(legacyFlag), UI_MODE.legacy);

  const legacyEnv = { OMO_TUI: "legacy" };
  const nativeEnv = { OMO_TUI: "native" };
  assert.equal(
    selectUiMode(parseArguments([], legacyEnv), legacyEnv),
    UI_MODE.legacy
  );
  assert.equal(
    selectUiMode(parseArguments([], nativeEnv), nativeEnv),
    UI_MODE.native
  );

  // Explicit flags always beat OMO_TUI.
  assert.equal(
    selectUiMode(parseArguments(["--legacy-tui"], nativeEnv), nativeEnv),
    UI_MODE.legacy
  );
  assert.equal(
    selectUiMode(parseArguments(["--native"], legacyEnv), legacyEnv),
    UI_MODE.native
  );

  assert.throws(
    () => selectUiMode(parseArguments(["--native", "--legacy-tui"], {})),
    NATIVE_LEGACY_CONFLICT_PATTERN
  );

  const bogus = { OMO_TUI: "bogus" };
  assert.throws(
    () => selectUiMode(parseArguments([], bogus), bogus),
    INVALID_OMO_TUI_PATTERN
  );
  // An explicit flag resolves the local mode, so a stale/typo env value is
  // not consulted.
  assert.equal(
    selectUiMode(parseArguments(["--legacy-tui"], bogus), bogus),
    UI_MODE.legacy
  );
});

const REMOTE_ENDPOINT = {
  transport: "http",
  url: "http://registry-remote.example:5189",
};

function makeRegistryDataDir({
  corrupt = false,
  endpoint,
  missing = false,
  selected = true,
} = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-ui-mode-"));
  if (missing) {
    return dataDir;
  }
  if (corrupt) {
    fs.writeFileSync(path.join(dataDir, "host-registry.json"), "{ not json");
    return dataDir;
  }
  let document = createEmptyHostRegistryDocument();
  if (endpoint) {
    const added = addHostRegistryEntry(document, {
      endpoint,
      id: "test-host",
      label: "Test Host",
    });
    document = selected
      ? selectHostRegistryEntry(added.document, added.entry.id)
      : added.document;
  }
  writeHostRegistry(dataDir, document);
  return dataDir;
}

function modeWithRegistry(options, env = process.env) {
  return selectUiMode(options, env, {
    selectedRegistryHostIsRemote: () =>
      selectedRegistryHostIsRemote(options, env),
  });
}

test("selectedRegistryHostIsRemote reports only http/https selections", () => {
  const remoteDirs = [
    makeRegistryDataDir({
      endpoint: { transport: "http", url: "http://host.example:5189" },
    }),
    makeRegistryDataDir({
      endpoint: { transport: "https", url: "https://host.example:5189" },
    }),
  ];
  for (const dataDir of remoteDirs) {
    assert.equal(
      selectedRegistryHostIsRemote(parseArguments(["--data-dir", dataDir], {})),
      true
    );
  }

  const localDirs = [
    makeRegistryDataDir({
      endpoint: { path: "/tmp/omo.sock", transport: "unix" },
    }),
    makeRegistryDataDir({
      endpoint: { path: "\\\\.\\pipe\\omo", transport: "pipe" },
    }),
  ];
  for (const dataDir of localDirs) {
    assert.equal(
      selectedRegistryHostIsRemote(parseArguments(["--data-dir", dataDir], {})),
      false
    );
  }
});

test("selectedRegistryHostIsRemote treats unusable registries as not remote", () => {
  const dirs = [
    makeRegistryDataDir({ missing: true }),
    makeRegistryDataDir({ corrupt: true }),
    makeRegistryDataDir({ endpoint: REMOTE_ENDPOINT, selected: false }),
  ];
  for (const dataDir of dirs) {
    assert.equal(
      selectedRegistryHostIsRemote(parseArguments(["--data-dir", dataDir], {})),
      false
    );
  }
});

test("plain omo honors a selected remote registry Host with the legacy TUI", () => {
  const dataDir = makeRegistryDataDir({ endpoint: REMOTE_ENDPOINT });
  const mode = modeWithRegistry(parseArguments(["--data-dir", dataDir], {}));
  assert.equal(mode, UI_MODE.legacy);
  // Legacy is the branch that skips `runNativePi`; only `native` calls it.
  assert.notEqual(mode, UI_MODE.native);
});

test("plain omo stays native for local, missing or corrupt registry selections", () => {
  const dirs = [
    makeRegistryDataDir({
      endpoint: { path: "/tmp/omo.sock", transport: "unix" },
    }),
    makeRegistryDataDir({
      endpoint: { path: "\\\\.\\pipe\\omo", transport: "pipe" },
    }),
    makeRegistryDataDir({ missing: true }),
    makeRegistryDataDir({ corrupt: true }),
    makeRegistryDataDir({ endpoint: REMOTE_ENDPOINT, selected: false }),
  ];
  for (const dataDir of dirs) {
    const options = parseArguments(["--data-dir", dataDir], {});
    assert.equal(modeWithRegistry(options), UI_MODE.native, dataDir);
  }
});

test("explicit --native overrides a selected remote registry Host", () => {
  const dataDir = makeRegistryDataDir({ endpoint: REMOTE_ENDPOINT });
  const options = parseArguments(["--native", "--data-dir", dataDir], {});
  assert.equal(modeWithRegistry(options), UI_MODE.native);
});

test("OMO_TUI beats the registry selection without reading it", () => {
  const dataDir = makeRegistryDataDir({ endpoint: REMOTE_ENDPOINT });
  const options = parseArguments(["--data-dir", dataDir], {});
  const registryMustNotBeRead = {
    selectedRegistryHostIsRemote: () => {
      throw new Error("registry must not be consulted when OMO_TUI is set");
    },
  };
  const legacyEnv = { OMO_TUI: "legacy" };
  assert.equal(
    selectUiMode(options, legacyEnv, registryMustNotBeRead),
    UI_MODE.legacy
  );
  const nativeEnv = { OMO_TUI: "native" };
  assert.equal(
    selectUiMode(options, nativeEnv, registryMustNotBeRead),
    UI_MODE.native
  );
});

test("plain omo routes a selected remote registry Host to legacy, not native Pi", () => {
  const dataDir = makeRegistryDataDir({
    endpoint: { transport: "http", url: "http://127.0.0.1:1" },
  });
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "cli", "omo.mjs"), "--data-dir", dataDir],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ...scrubOmoEnv,
        OMO_DATA_DIR: "",
        OMO_LOCAL_SOCKET: "",
        OMO_TUI: "",
        OMO_URL: "",
      },
      timeout: 60_000,
    }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, REGISTRY_CONNECT_PATTERN);
  assert.doesNotMatch(result.stderr, NATIVE_LAUNCH_PATTERN);
});

test("omo --help prints the CLI usage without launching a daemon", () => {
  const output = execFileSync(
    process.execPath,
    [path.join(ROOT, "cli", "omo.mjs"), "--help"],
    { encoding: "utf8" }
  );
  assert.match(output, USAGE_HEADER_PATTERN);
  assert.match(output, NATIVE_FLAG_PATTERN);
  assert.match(output, LEGACY_FLAG_PATTERN);
});

test("buildNativeSpawnArgs always loads exactly one extension first", () => {
  assert.deepEqual(buildNativeSpawnArgs({ extensionPath: "/x/index.js" }), [
    "--extension",
    "/x/index.js",
  ]);
  assert.deepEqual(
    buildNativeSpawnArgs({
      extensionPath: "/x/index.js",
      passthroughArgs: ["--model", "test"],
    }),
    ["--extension", "/x/index.js", "--model", "test"]
  );
});

/** Captures the message of a synchronous throw for exact-text assertions. */
function captureErrorMessage(run) {
  try {
    run();
  } catch (error) {
    return error.message;
  }
  throw new Error("Expected the call to throw");
}

function captureStream() {
  let output = "";
  return {
    stream: {
      write: (chunk) => {
        output += chunk;
      },
    },
    text: () => output,
  };
}

function makeLaunchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omo-native-launch-"));
}

function writeLaunchScript(directory, name, body) {
  const file = path.join(directory, `${name}.mjs`);
  fs.writeFileSync(file, body);
  return file;
}

test("version mismatch names the resolved version, pin, fix and escape hatch", () => {
  const message = captureErrorMessage(() => assertSupportedPiVersion("0.87.0"));
  assert.match(message, VERSION_MISMATCH_PATTERN);
  assert.match(message, VERSION_LINE_PATTERN);
  assert.match(message, PIN_LOCATION_PATTERN);
  assert.match(message, PNPM_INSTALL_PATTERN);
  assert.match(message, ESCAPE_HATCH_PATTERN);
  assert.ok(message.includes(NATIVE_TUI_FALLBACK_HINT));
});

test("missing Pi binary and extension errors carry remediation and escape hatch", () => {
  const missingBinary = captureErrorMessage(() =>
    resolvePiBinary({
      resolveEntry: () => {
        throw new Error("ERR_MODULE_NOT_FOUND");
      },
    })
  );
  assert.match(missingBinary, PNPM_INSTALL_PATTERN);
  assert.match(missingBinary, ESCAPE_HATCH_PATTERN);

  const missingExtension = captureErrorMessage(() =>
    assertExtensionExists("/repo/packages/pi-extension/index.js", {
      exists: () => false,
    })
  );
  assert.match(missingExtension, MISSING_EXTENSION_PATTERN);
  assert.match(missingExtension, PNPM_INSTALL_PATTERN);
  assert.match(missingExtension, ESCAPE_HATCH_PATTERN);
});

test("formatPiStartupFailureHint names the exit code, startup window and escape hatch", () => {
  const hint = formatPiStartupFailureHint({
    command: "/repo/node_modules/pi/cli.js",
    elapsedMs: 12,
    exitCode: 42,
  });
  assert.match(hint, PI_CLI_PATH_PATTERN);
  assert.match(hint, EXIT_CODE_42_PATTERN);
  assert.match(hint, new RegExp(`${PI_STARTUP_WINDOW_MS}ms startup window`));
  assert.match(hint, STARTUP_FAILURE_PATTERN);
  assert.ok(hint.includes(NATIVE_TUI_FALLBACK_HINT));
});

test("runForeground propagates a startup death and prints the actionable hint", async () => {
  const directory = makeLaunchDir();
  const script = writeLaunchScript(directory, "die", "process.exit(42);\n");
  const captured = captureStream();
  const exitCode = await runForeground({
    args: [script],
    command: process.execPath,
    cwd: directory,
    env: process.env,
    stderr: captured.stream,
  });
  assert.equal(exitCode, 42);
  const stderr = captured.text();
  assert.match(stderr, STARTUP_FAILURE_PATTERN);
  assert.match(stderr, EXIT_CODE_42_PATTERN);
  assert.match(stderr, ESCAPE_HATCH_PATTERN);
  assert.ok(stderr.includes(NATIVE_TUI_FALLBACK_HINT));
});

test("runForeground stays silent when the child quits after the startup window", async () => {
  const directory = makeLaunchDir();
  const clean = writeLaunchScript(
    directory,
    "late-clean",
    "setTimeout(() => process.exit(0), 150);\n"
  );
  const cleanCapture = captureStream();
  const cleanCode = await runForeground({
    args: [clean],
    command: process.execPath,
    cwd: directory,
    env: process.env,
    startupWindowMs: 50,
    stderr: cleanCapture.stream,
  });
  assert.equal(cleanCode, 0);
  assert.equal(cleanCapture.text(), "");

  const nonzero = writeLaunchScript(
    directory,
    "late-nonzero",
    "setTimeout(() => process.exit(7), 150);\n"
  );
  const nonzeroCapture = captureStream();
  const nonzeroCode = await runForeground({
    args: [nonzero],
    command: process.execPath,
    cwd: directory,
    env: process.env,
    startupWindowMs: 50,
    stderr: nonzeroCapture.stream,
  });
  // A late nonzero quit is a normal quit: the exit code is preserved and no
  // startup hint is printed.
  assert.equal(nonzeroCode, 7);
  assert.equal(nonzeroCapture.text(), "");
});

test("runForeground wraps a spawn failure with context and the escape hatch", async () => {
  const missingBinary = path.join(
    os.tmpdir(),
    "omo-missing-pi-dir",
    "pi-binary"
  );
  await assert.rejects(
    runForeground({
      args: [],
      command: missingBinary,
      cwd: os.tmpdir(),
      env: process.env,
    }),
    (error) => {
      assert.match(error.message, SPAWN_FAILURE_PATTERN);
      assert.ok(error.message.includes(missingBinary));
      assert.match(error.message, PNPM_INSTALL_PATTERN);
      assert.match(error.message, ESCAPE_HATCH_PATTERN);
      return true;
    }
  );
});

test("ensureLocalHostForNative adds the shared-daemon note without duplicating omo serve", async () => {
  const daemonError = new Error(
    "Timed out after 30000ms waiting for the local omo Host at unix:/tmp/omo.sock (data dir /tmp/omo). Run `omo serve` to see startup errors."
  );
  await assert.rejects(
    ensureLocalHostForNative(() => {
      throw daemonError;
    }, {}),
    (error) => {
      assert.equal(error.cause, daemonError);
      assert.ok(error.message.startsWith(daemonError.message));
      assert.ok(error.message.includes(DAEMON_SHARED_TUI_HINT));
      assert.match(error.message, DAEMON_SHARED_PATTERN);
      assert.match(error.message, ESCAPE_HATCH_PATTERN);
      // The underlying `omo serve` suggestion is neither removed nor repeated.
      assert.equal(error.message.split("omo serve").length - 1, 1);
      return true;
    }
  );

  // A reachable daemon passes through untouched.
  const endpoint = { kind: "unix", path: "/x.sock" };
  const connected = await ensureLocalHostForNative(() => ({ endpoint }), {});
  assert.deepEqual(connected, { endpoint });
});
