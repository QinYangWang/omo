import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseArguments } from "../cli/local-host.mjs";
import {
  assertExtensionExists,
  assertSupportedPiVersion,
  buildNativeEnv,
  buildNativeSpawnArgs,
  buildNativeSpawnConfig,
  defaultExtensionPath,
  EXPECTED_PI_MAJOR_MINOR,
  EXTENSION_RELATIVE_PATH,
  PI_PACKAGE_NAME,
  parseMajorMinor,
  resolvePiBinary,
} from "../cli/native-pi.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPO_NODE_MODULES = path.join(ROOT, "node_modules");
const GLOBAL_PI_PREFIX = path.join("/root", ".local", "share", "pi-node");
const UNSUPPORTED_PATTERN = /Unsupported Pi version/;
const PNPM_INSTALL_PATTERN = /pnpm install/;
const MISSING_BIN_PATTERN = /missing at .*cli\.js/;
const MISSING_BIN_KEY_PATTERN = /bin\.pi/;
const MISSING_EXTENSION_PATTERN = /extension is missing/;

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
  assert.equal(parseMajorMinor("0.85.0"), "0.85");
  assert.equal(parseMajorMinor("0.85"), "0.85");
  assert.equal(parseMajorMinor("0.85.0-beta.1"), "0.85");
  assert.equal(parseMajorMinor("1.2.3"), "1.2");
  assert.equal(parseMajorMinor("garbage"), null);
  assert.equal(parseMajorMinor(undefined), null);
});

test("assertSupportedPiVersion accepts the pinned line and rejects drift", () => {
  assert.equal(assertSupportedPiVersion("0.85.0"), "0.85.0");
  assert.equal(assertSupportedPiVersion("0.85.7"), "0.85.7");
  assert.throws(() => assertSupportedPiVersion("0.86.0"), UNSUPPORTED_PATTERN);
  assert.throws(() => assertSupportedPiVersion("1.0.0"), UNSUPPORTED_PATTERN);
  assert.throws(() => assertSupportedPiVersion("0.84.9"), UNSUPPORTED_PATTERN);
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
    version: "0.85.0",
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
          JSON.stringify({ name: PI_PACKAGE_NAME, version: "0.85.0" }),
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
    version: "0.86.0",
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

test("buildNativeSpawnConfig wires the extension and passes the events URL through", () => {
  const extensionPath = defaultExtensionPath(ROOT);
  const binaryPath = "/repo/node_modules/.pnpm/pi/dist/bundle/cli.js";
  const config = buildNativeSpawnConfig({
    baseEnv: { HOME: "/home/me", OMO_TOKEN: "super-secret" },
    binaryPath,
    cwd: "/tmp/work",
    extensionPath,
    passthroughArgs: ["--help"],
  });
  assert.equal(config.command, binaryPath);
  assert.equal(config.cwd, "/tmp/work");
  assert.deepEqual(config.args, ["--extension", extensionPath, "--help"]);
  assert.equal("OMO_EXTENSION_EVENTS_URL" in config.env, false);
  assert.equal("OMO_TOKEN" in config.env, false);
  assert.equal(JSON.stringify(config.env).includes("super-secret"), false);
  assert.equal(config.env.HOME, "/home/me");

  const withUrl = buildNativeSpawnConfig({
    baseEnv: {
      HOME: "/home/me",
      OMO_EXTENSION_EVENTS_URL: "http://127.0.0.1:1234/events",
    },
    binaryPath,
    extensionPath,
  });
  assert.equal(
    withUrl.env.OMO_EXTENSION_EVENTS_URL,
    "http://127.0.0.1:1234/events"
  );

  const explicit = buildNativeEnv({
    baseEnv: { OMO_EXTENSION_EVENTS_URL: "  http://127.0.0.1:9/events  " },
  });
  assert.equal(explicit.OMO_EXTENSION_EVENTS_URL, "http://127.0.0.1:9/events");

  const blank = buildNativeEnv({
    baseEnv: { OMO_EXTENSION_EVENTS_URL: "   " },
  });
  assert.equal("OMO_EXTENSION_EVENTS_URL" in blank, false);
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
