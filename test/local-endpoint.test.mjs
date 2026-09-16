import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  DEFAULT_MAX_UNIX_SOCKET_PATH_BYTES,
  assertManagedLocalEndpoint,
  localEndpointHash,
  prepareLocalEndpoint,
  removeLocalEndpoint,
  resolveLocalEndpoint,
} = require("../server/local-endpoint.cjs");

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
const HASH_PATTERN = /^[0-9a-f]{16}$/;
const UNIX_SOCKET_FILE_PATTERN = /^host-[0-9a-f]{16}\.sock$/;
const WINDOWS_PIPE_SUFFIX_PATTERN = /^omo-[0-9a-f]{16}$/;
const APPROVED_ROOT_PATTERN = /approved runtime directory/;
const ALREADY_IN_USE_PATTERN = /already in use/;
const NON_SOCKET_PATTERN = /non-socket path/;

test("generates a deterministic Unix socket path under the data directory", () => {
  const dataDir = path.join(os.tmpdir(), "omo-endpoint-pure");
  const first = resolveLocalEndpoint({ dataDir, platform: "linux" });
  const second = resolveLocalEndpoint({ dataDir, platform: "linux" });

  assert.equal(first.kind, "unix");
  assert.equal(first.explicit, false);
  assert.equal(first.path, second.path);
  assert.equal(first.root, path.join(dataDir, "run"));
  assert.match(path.basename(first.path), UNIX_SOCKET_FILE_PATTERN);
  assert.equal(path.dirname(first.path), first.root);
});

test("hashes variable input instead of leaking it into the socket name", () => {
  const dataDir = path.join(os.tmpdir(), "omo-endpoint-pure");
  const endpoint = resolveLocalEndpoint({
    dataDir,
    platform: "linux",
    scope: "../../etc/passwd",
  });

  assert.equal(endpoint.path.includes("passwd"), false);
  assert.equal(endpoint.path.includes(".."), false);
  assert.match(path.basename(endpoint.path), UNIX_SOCKET_FILE_PATTERN);
  assert.match(localEndpointHash("scope-a"), HASH_PATTERN);
  assert.equal(localEndpointHash("scope-a"), localEndpointHash("scope-a"));
  assert.notEqual(localEndpointHash("scope-a"), localEndpointHash("scope-b"));
});

test("falls back to a short hashed path when the data directory is too long", () => {
  const dataDir = path.join(os.tmpdir(), "omo".repeat(60));
  const endpoint = resolveLocalEndpoint({
    dataDir,
    platform: "linux",
    tmpDir: os.tmpdir(),
  });

  assert.equal(endpoint.kind, "unix");
  assert.notEqual(endpoint.root, path.join(path.resolve(dataDir), "run"));
  assert.ok(
    Buffer.byteLength(endpoint.path, "utf8") <=
      DEFAULT_MAX_UNIX_SOCKET_PATH_BYTES
  );
  assert.match(path.basename(endpoint.path), UNIX_SOCKET_FILE_PATTERN);
  assert.equal(path.dirname(endpoint.path), endpoint.root);
});

test("keeps an explicit Unix socket path inside the managed runtime directory", () => {
  const dataDir = path.join(os.tmpdir(), "omo-endpoint-pure");
  const explicit = path.join(dataDir, "run", "custom.sock");
  const endpoint = resolveLocalEndpoint({
    dataDir,
    explicit,
    platform: "linux",
  });

  assert.equal(endpoint.explicit, true);
  assert.equal(endpoint.path, explicit);
  assert.equal(endpoint.root, path.join(dataDir, "run"));
});

test("refuses an explicit Unix socket path outside approved managed roots", () => {
  const dataDir = path.join(os.tmpdir(), "omo-endpoint-pure");
  const outside = path.join(os.tmpdir(), "omo-endpoint-outside", "custom.sock");

  assert.throws(
    () =>
      resolveLocalEndpoint({ dataDir, explicit: outside, platform: "linux" }),
    APPROVED_ROOT_PATTERN
  );
  assert.throws(() =>
    resolveLocalEndpoint({
      dataDir,
      explicit: path.join(path.dirname(dataDir), "escape.sock"),
      platform: "linux",
    })
  );
  // The temp fallback is only approved when the primary path is too long.
  const shortFallbackRoot = path.join(
    os.tmpdir(),
    `omo-${localEndpointHash(`${path.resolve(dataDir)}\u0000default`)}`
  );
  assert.throws(
    () =>
      resolveLocalEndpoint({
        dataDir,
        explicit: path.join(shortFallbackRoot, "custom.sock"),
        platform: "linux",
      }),
    APPROVED_ROOT_PATTERN
  );
});

test("allows an explicit socket inside the generated temp fallback root", () => {
  const dataDir = path.join(os.tmpdir(), "omo".repeat(60));
  const fallbackRoot = path.join(
    os.tmpdir(),
    `omo-${localEndpointHash(`${path.resolve(dataDir)}\u0000default`)}`
  );
  const explicit = path.join(fallbackRoot, "custom.sock");
  const endpoint = resolveLocalEndpoint({
    dataDir,
    explicit,
    platform: "linux",
  });

  assert.equal(endpoint.explicit, true);
  assert.equal(endpoint.path, explicit);
  assert.equal(endpoint.root, fallbackRoot);
});

test("generates a deterministic Windows named pipe name", () => {
  const dataDir = "C:\\Users\\demo\\.omo-server";
  const first = resolveLocalEndpoint({ dataDir, platform: "win32" });
  const second = resolveLocalEndpoint({ dataDir, platform: "win32" });

  assert.equal(first.kind, "pipe");
  assert.equal(first.explicit, false);
  assert.equal(first.root, "");
  assert.equal(first.path, second.path);
  assert.ok(first.path.startsWith(WINDOWS_PIPE_PREFIX));
  assert.match(
    first.path.slice(WINDOWS_PIPE_PREFIX.length),
    WINDOWS_PIPE_SUFFIX_PATTERN
  );
  assert.equal(first.path.includes("Users"), false);
});

test("normalizes an explicit Windows named pipe without dropping the prefix", () => {
  const dataDir = "C:\\Users\\demo\\.omo-server";
  const explicitPipe = `${WINDOWS_PIPE_PREFIX}omo-custom`;
  const full = resolveLocalEndpoint({
    dataDir,
    explicit: explicitPipe,
    platform: "win32",
  });
  const bare = resolveLocalEndpoint({
    dataDir,
    explicit: "omo-custom",
    platform: "win32",
  });

  assert.equal(full.path, explicitPipe);
  assert.equal(bare.path, explicitPipe);
  assert.equal(full.explicit, true);
  assert.equal(bare.explicit, true);
});

test("managed socket guard refuses paths outside the runtime directory", () => {
  const endpoint = resolveLocalEndpoint({
    dataDir: path.join(os.tmpdir(), "omo-endpoint-pure"),
    platform: "linux",
  });

  assert.doesNotThrow(() => assertManagedLocalEndpoint(endpoint));
  assert.throws(() =>
    assertManagedLocalEndpoint({
      kind: "unix",
      path: path.join(os.tmpdir(), "outside", "evil.sock"),
      root: path.join(os.tmpdir(), "inside"),
    })
  );
});

function listenOnSocket(socketPath) {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function canConnect(socketPath) {
  return new Promise((resolve, reject) => {
    const probe = net.createConnection({ path: socketPath });
    probe.once("connect", () => {
      probe.destroy();
      resolve();
    });
    probe.once("error", reject);
  });
}

test("prepareLocalEndpoint refuses to unlink a live Unix socket", {
  skip: process.platform === "win32" ? "Unix only" : false,
}, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-endpoint-live-"));
  const endpoint = resolveLocalEndpoint({
    dataDir,
    platform: process.platform,
  });
  fs.mkdirSync(endpoint.root, { mode: 0o700, recursive: true });
  const server = await listenOnSocket(endpoint.path);
  const before = fs.lstatSync(endpoint.path);
  try {
    await assert.rejects(
      () => prepareLocalEndpoint(endpoint),
      ALREADY_IN_USE_PATTERN
    );
    assert.equal(fs.existsSync(endpoint.path), true);
    const after = fs.lstatSync(endpoint.path);
    assert.equal(after.ino, before.ino);
    assert.equal(after.dev, before.dev);
    await canConnect(endpoint.path);
  } finally {
    await closeServer(server);
    fs.rmSync(dataDir, { force: true, recursive: true });
  }
});

test("prepareLocalEndpoint rejects a non-socket path instead of unlinking it", {
  skip: process.platform === "win32" ? "Unix only" : false,
}, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-endpoint-file-"));
  const endpoint = resolveLocalEndpoint({
    dataDir,
    platform: process.platform,
  });
  fs.mkdirSync(endpoint.root, { mode: 0o700, recursive: true });
  fs.writeFileSync(endpoint.path, "not a socket");
  try {
    await assert.rejects(
      () => prepareLocalEndpoint(endpoint),
      NON_SOCKET_PATTERN
    );
    assert.equal(fs.readFileSync(endpoint.path, "utf8"), "not a socket");
  } finally {
    fs.rmSync(dataDir, { force: true, recursive: true });
  }
});

test("removeLocalEndpoint only unlinks a socket this endpoint bound", {
  skip: process.platform === "win32" ? "Unix only" : false,
}, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-endpoint-own-"));
  const endpoint = resolveLocalEndpoint({
    dataDir,
    platform: process.platform,
  });
  fs.mkdirSync(endpoint.root, { mode: 0o700, recursive: true });
  const server = await listenOnSocket(endpoint.path);
  try {
    assert.equal(removeLocalEndpoint(endpoint), false);
    assert.equal(fs.existsSync(endpoint.path), true);
    endpoint.owned = true;
    assert.equal(removeLocalEndpoint(endpoint), true);
    assert.equal(fs.existsSync(endpoint.path), false);
  } finally {
    await closeServer(server);
    fs.rmSync(dataDir, { force: true, recursive: true });
  }
});
