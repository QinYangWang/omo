import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI_ENTRY = path.join(ROOT, "cli", "omo.mjs");
const HOST_ADDRESS = "127.0.0.1";
const CLI_TIMEOUT_MS = 90_000;
const CLOCK_HOST_ID = "e5f752f6-f3e6-4183-ba91-c14491db90f2";
const OTHER_HOST_ID = "e5f752f6-f3e6-4183-ba91-c14491db90f3";
const SECRET = "cli-super-secret-token";
const DUPLICATE_PATTERN = /already configured/;
const UNKNOWN_PATTERN = /Unknown Host entry/;
const CREDENTIAL_PATTERN = /credential could not be resolved/;
const UNREACHABLE_PATTERN = /unreachable/;
const MISMATCH_PATTERN = /identity mismatch/;
const ADDED_HOST_PATTERN = /Added Host (\S+)/;
const HTTP_ONLY_PATTERN = /HTTP or HTTPS/;
const INVALID_ENV_PATTERN = /Invalid credential environment variable name/;
const USAGE_ADD_PATTERN = /Usage: omo host add/;
const MALFORMED_REGISTRY_PATTERN = /Host registry file is (malformed|invalid)/;
const SESSION_ONLINE_PATTERN = /session-online/;

function makeLayout(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `omo-registry-${label}-`));
  const dataDir = path.join(root, "data");
  const agentDir = path.join(root, "agent");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { agentDir, dataDir, root, workspaceDir };
}

function cliEnv(layout, extra = {}) {
  return {
    ...process.env,
    OMO_DATA_DIR: layout.dataDir,
    OMO_LOCAL_SOCKET: "",
    OMO_TOKEN: "",
    OMO_URL: "",
    OMO_WORKSPACE_ROOTS: layout.workspaceDir,
    PI_CODING_AGENT_DIR: layout.agentDir,
    ...extra,
  };
}

function runCli(args, env, { timeoutMs = CLI_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: ${args.join(" ")}\n${stderr.join("")}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stderr: stderr.join(""),
        stdout: stdout.join(""),
      });
    });
  });
}

function readRegistry(layout) {
  const filePath = path.join(layout.dataDir, "host-registry.json");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function daemonStateExists(layout) {
  return fs.existsSync(path.join(layout.dataDir, "daemon.json"));
}

async function addHost(layout, args) {
  const result = await runCli(["host", "add", ...args], cliEnv(layout));
  assert.equal(result.code, 0, result.stderr);
  const match = ADDED_HOST_PATTERN.exec(result.stdout);
  assert.ok(match, result.stdout);
  return match[1];
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, HOST_ADDRESS, () => {
      const address = probe.address();
      assert.notEqual(address, null);
      assert.equal(typeof address, "object");
      probe.close(() => resolve(address.port));
    });
  });
}

/** A minimal real Host: health plus a Session list with one entry. */
async function startHostServer({ getHostId, workspaceDir, onRequest }) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    onRequest?.(request, url.pathname);
    if (url.pathname === "/api/v1/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          capabilities: [],
          hostId: getHostId(),
          ok: true,
          protocolVersion: 1,
          version: 1,
        })
      );
      return;
    }
    if (url.pathname === "/api/v1/sessions") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify([
          {
            created: 1,
            cwd: workspaceDir,
            firstMessage: "Hello from online",
            id: "session-online",
            modified: 2,
            path: "/sessions/online.jsonl",
          },
        ])
      );
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, HOST_ADDRESS, resolve));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

test("host add normalizes endpoints, rejects duplicates and bad input", async () => {
  const layout = makeLayout("crud");
  try {
    const id = await addHost(layout, [
      "--name",
      "Team",
      "--url",
      "https://HOST.example:443/",
    ]);
    const registry = readRegistry(layout);
    assert.equal(registry.entries.length, 1);
    assert.equal(registry.entries[0].endpoint.url, "https://host.example");
    assert.equal(registry.entries[0].id, id);
    const mode = fs
      .statSync(path.join(layout.dataDir, "host-registry.json"))
      .mode.toString(8);
    assert.equal(mode.slice(-3), "600");

    const duplicate = await runCli(
      ["host", "add", "--name", "Dup", "--url", "https://host.example"],
      cliEnv(layout)
    );
    assert.notEqual(duplicate.code, 0);
    assert.match(duplicate.stderr, DUPLICATE_PATTERN);
    assert.equal(readRegistry(layout).entries.length, 1);

    const socket = await runCli(
      ["host", "add", "--name", "Sock", "--url", "unix:///tmp/x.sock"],
      cliEnv(layout)
    );
    assert.notEqual(socket.code, 0);
    assert.match(socket.stderr, HTTP_ONLY_PATTERN);

    const badEnv = await runCli(
      [
        "host",
        "add",
        "--name",
        "Bad",
        "--url",
        "http://bad.example:1",
        "--credential-env",
        "1BAD",
      ],
      cliEnv(layout)
    );
    assert.notEqual(badEnv.code, 0);
    assert.match(badEnv.stderr, INVALID_ENV_PATTERN);

    const missingName = await runCli(
      ["host", "add", "--url", "http://missing.example:1"],
      cliEnv(layout)
    );
    assert.notEqual(missingName.code, 0);
    assert.match(missingName.stderr, USAGE_ADD_PATTERN);

    const removed = await runCli(["host", "remove", id], cliEnv(layout));
    assert.equal(removed.code, 0, removed.stderr);
    assert.deepEqual(readRegistry(layout).entries, []);

    const unknown = await runCli(["host", "remove", "missing"], cliEnv(layout));
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, UNKNOWN_PATTERN);
    assert.equal(daemonStateExists(layout), false);
  } finally {
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("host add trims --name and rejects whitespace-only labels", async () => {
  const layout = makeLayout("name");
  try {
    const blank = await runCli(
      ["host", "add", "--name", "   ", "--url", "http://blank.example:1"],
      cliEnv(layout)
    );
    assert.notEqual(blank.code, 0);
    assert.match(blank.stderr, USAGE_ADD_PATTERN);
    assert.equal(
      fs.existsSync(path.join(layout.dataDir, "host-registry.json")),
      false
    );

    const id = await addHost(layout, [
      "--name",
      "  Trimmed Name  ",
      "--url",
      "http://trim.example:1",
    ]);
    const registry = readRegistry(layout);
    assert.equal(registry.entries.length, 1);
    assert.equal(registry.entries[0].id, id);
    assert.equal(registry.entries[0].label, "Trimmed Name");
  } finally {
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("malformed registry files are a hard error and never reset", async () => {
  const layout = makeLayout("malformed");
  const filePath = path.join(layout.dataDir, "host-registry.json");
  try {
    for (const raw of [
      "{not-json",
      JSON.stringify({
        entries: [{ id: "x" }],
        schema: "omo.host-registry",
        version: 1,
      }),
    ]) {
      fs.writeFileSync(filePath, raw, "utf8");
      // biome-ignore lint/performance/noAwaitInLoops: malformed cases run sequentially.
      const result = await runCli(["host", "list"], cliEnv(layout));
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, MALFORMED_REGISTRY_PATTERN);
      assert.equal(fs.readFileSync(filePath, "utf8"), raw);
    }
    assert.equal(daemonStateExists(layout), false);
  } finally {
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("host use persists selection and local clears it without deleting entries", async () => {
  const layout = makeLayout("select");
  try {
    const id = await addHost(layout, [
      "--name",
      "Team",
      "--url",
      "https://host.example",
    ]);
    const used = await runCli(["host", "use", id], cliEnv(layout));
    assert.equal(used.code, 0, used.stderr);
    assert.equal(readRegistry(layout).selectedEntryId, id);

    const unknown = await runCli(["host", "use", "missing"], cliEnv(layout));
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, UNKNOWN_PATTERN);
    assert.equal(readRegistry(layout).selectedEntryId, id);

    const local = await runCli(["host", "use", "local"], cliEnv(layout));
    assert.equal(local.code, 0, local.stderr);
    const registry = readRegistry(layout);
    assert.equal("selectedEntryId" in registry, false);
    assert.equal(registry.entries.length, 1);
  } finally {
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("explicit transport outranks --server and does not touch the registry", async () => {
  const layout = makeLayout("precedence");
  const server = await startHostServer({
    getHostId: () => CLOCK_HOST_ID,
    workspaceDir: layout.workspaceDir,
  });
  try {
    const unknownId = await runCli(
      [
        "--server",
        "missing",
        "--url",
        server.baseUrl,
        "session",
        "list",
        "--cwd",
        layout.workspaceDir,
      ],
      cliEnv(layout)
    );
    assert.equal(unknownId.code, 0, unknownId.stderr);
    assert.match(unknownId.stdout, SESSION_ONLINE_PATTERN);

    const envUrl = await runCli(
      ["--server", "missing", "session", "list", "--cwd", layout.workspaceDir],
      cliEnv(layout, { OMO_URL: server.baseUrl })
    );
    assert.equal(envUrl.code, 0, envUrl.stderr);
    assert.match(envUrl.stdout, SESSION_ONLINE_PATTERN);

    // An explicit URL target must never create or consult a registry file.
    assert.equal(
      fs.existsSync(path.join(layout.dataDir, "host-registry.json")),
      false
    );

    const unknown = await runCli(
      ["--server", "missing", "session", "list", "--cwd", layout.workspaceDir],
      cliEnv(layout)
    );
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, UNKNOWN_PATTERN);
  } finally {
    await server.close();
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("registry connection pins identity, resolves env credentials and isolates failures", async () => {
  const layout = makeLayout("integration");
  const requests = [];
  let hostId = CLOCK_HOST_ID;
  const online = await startHostServer({
    getHostId: () => hostId,
    onRequest: (request, pathname) => {
      if (pathname === "/api/v1/health" || pathname === "/api/v1/sessions") {
        requests.push(request.headers.authorization ?? "");
      }
    },
    workspaceDir: layout.workspaceDir,
  });
  const offlinePort = await freePort();
  const offlineUrl = `http://${HOST_ADDRESS}:${offlinePort}`;
  try {
    const onlineId = await addHost(layout, [
      "--name",
      "Online",
      "--url",
      online.baseUrl,
      "--credential-env",
      "OMO_CLI_TEST_TOKEN",
    ]);
    const offlineId = await addHost(layout, [
      "--name",
      "Offline",
      "--url",
      offlineUrl,
    ]);

    const connect = await runCli(
      ["--server", onlineId, "session", "list", "--cwd", layout.workspaceDir],
      cliEnv(layout, { OMO_CLI_TEST_TOKEN: SECRET })
    );
    assert.equal(connect.code, 0, connect.stderr);
    assert.match(connect.stdout, SESSION_ONLINE_PATTERN);
    assert.deepEqual(requests, [`Bearer ${SECRET}`, `Bearer ${SECRET}`]);

    // First successful health pins the Host identity atomically.
    let registry = readRegistry(layout);
    const onlineEntry = registry.entries.find((entry) => entry.id === onlineId);
    assert.equal(onlineEntry.expectedHostId, CLOCK_HOST_ID);
    assert.equal(onlineEntry.credentialRef, "env:OMO_CLI_TEST_TOKEN");
    // Tokens are never persisted.
    assert.equal(
      fs
        .readFileSync(path.join(layout.dataDir, "host-registry.json"), "utf8")
        .includes(SECRET),
      false
    );

    // The offline entry does not affect the available Host.
    const isolated = await runCli(
      ["--server", onlineId, "session", "list", "--cwd", layout.workspaceDir],
      cliEnv(layout, { OMO_CLI_TEST_TOKEN: SECRET })
    );
    assert.equal(isolated.code, 0, isolated.stderr);
    assert.match(isolated.stdout, SESSION_ONLINE_PATTERN);

    // A missing credential is explicit and never leaks the secret.
    const missing = await runCli(
      ["--server", onlineId, "session", "list", "--cwd", layout.workspaceDir],
      cliEnv(layout)
    );
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, CREDENTIAL_PATTERN);
    assert.equal(missing.stderr.includes(SECRET), false);
    registry = readRegistry(layout);
    assert.equal(
      registry.entries.find((entry) => entry.id === onlineId).expectedHostId,
      CLOCK_HOST_ID
    );

    // An identity replacement is a hard, isolated failure.
    hostId = OTHER_HOST_ID;
    const mismatch = await runCli(
      ["--server", onlineId, "session", "list", "--cwd", layout.workspaceDir],
      cliEnv(layout, { OMO_CLI_TEST_TOKEN: SECRET })
    );
    assert.notEqual(mismatch.code, 0);
    assert.match(mismatch.stderr, MISMATCH_PATTERN);
    registry = readRegistry(layout);
    assert.equal(
      registry.entries.find((entry) => entry.id === onlineId).expectedHostId,
      CLOCK_HOST_ID,
      "mismatch must not rewrite the pinned identity"
    );

    // Selecting the offline Host fails and must not fall back to a local daemon.
    await runCli(["host", "use", offlineId], cliEnv(layout));
    const selectedOffline = await runCli(
      ["session", "list", "--cwd", layout.workspaceDir],
      cliEnv(layout)
    );
    assert.notEqual(selectedOffline.code, 0);
    assert.match(selectedOffline.stderr, UNREACHABLE_PATTERN);
    assert.equal(daemonStateExists(layout), false);

    // Selecting the online Host makes the default command succeed again.
    await runCli(["host", "use", onlineId], cliEnv(layout));
    hostId = CLOCK_HOST_ID;
    const selectedOnline = await runCli(
      ["session", "list", "--cwd", layout.workspaceDir],
      cliEnv(layout, { OMO_CLI_TEST_TOKEN: SECRET })
    );
    assert.equal(selectedOnline.code, 0, selectedOnline.stderr);
    assert.match(selectedOnline.stdout, SESSION_ONLINE_PATTERN);
    registry = readRegistry(layout);
    assert.equal(
      registry.entries.length,
      2,
      "one failure never mutates others"
    );
  } finally {
    await online.close();
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});
