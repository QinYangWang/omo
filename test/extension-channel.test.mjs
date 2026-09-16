import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalEndpointFetch } from "../cli/local-transport.mjs";

const require = createRequire(import.meta.url);
const { ExtensionService } = require("../server/extension-service.cjs");
const { resolveLocalEndpoint } = require("../server/local-endpoint.cjs");

const ROOT = path.resolve(import.meta.dirname, "..");
const HOST_ADDRESS = "127.0.0.1";
const HOST_ENTRY = path.join(ROOT, "server", "index.cjs");
const IS_WINDOWS = process.platform === "win32";
const SKIP_WINDOWS = IS_WINDOWS
  ? "Unix domain sockets are unavailable on Windows"
  : false;
const HEALTH_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 50;
const CREDENTIAL_PATTERN = /^[0-9a-f]{64}$/;
const INVALID_REGISTER_PATTERN = /Invalid ExtensionRegisterRequest/;
const PUBLIC_TOKEN = "public-secret";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    delay(ms).then(() => {
      throw new Error(message);
    }),
  ]);
}

function createLayout(label) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `omo-extension-${label}-`)
  );
  const dataDir = path.join(root, "data");
  const agentDir = path.join(root, "agent");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { agentDir, dataDir, root, workspaceDir };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, HOST_ADDRESS, () => {
      const address = probe.address();
      assert.notEqual(address, null);
      assert.equal(typeof address, "object");
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

function registerRequest(overrides = {}) {
  return {
    capabilities: ["commands", "events"],
    channelVersion: 1,
    extensionVersion: "0.1.0-test",
    instanceId: crypto.randomUUID(),
    piVersion: "0.85.0-test",
    sessionId: "session-extension-test",
    ...overrides,
  };
}

function nativeEvent(sequence, sessionId, overrides = {}) {
  return {
    event: "message_update",
    nativeSequence: sequence,
    payload: { type: "message_update" },
    sessionId,
    timestamp: Date.now(),
    ...overrides,
  };
}

function assertHostAlive(child, logs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `Host exited before becoming healthy (code=${child.exitCode}, signal=${child.signalCode})\n${logs.join("")}`
    );
  }
}

function spawnHost({
  agentDir,
  dataDir,
  extraEnv = {},
  port,
  token,
  transport,
  workspaceDir,
}) {
  const env = {
    ...process.env,
    OMO_DATA_DIR: dataDir,
    OMO_LOCAL_SOCKET: "",
    OMO_TOKEN: token,
    OMO_TRANSPORT: transport,
    OMO_WORKSPACE_ROOTS: workspaceDir,
    PI_CODING_AGENT_DIR: agentDir,
    ...extraEnv,
  };
  if (port !== undefined) {
    env.OMO_HOST = HOST_ADDRESS;
    env.OMO_PORT = String(port);
  }
  return spawnHostProcess(env);
}

function spawnHostProcess(env) {
  const child = spawn(process.execPath, [HOST_ENTRY], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  return { child, logs };
}

function waitForExit(child, timeoutMs = EXIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error("Host did not exit within the timeout"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function stopChild(child, signal = "SIGKILL") {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = waitForExit(child);
  child.kill(signal);
  await exited;
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function waitForSocketHealth(localFetch, child, logs, token) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    assertHostAlive(child, logs);
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Host startup must be polled sequentially.
      const response = await localFetch("http://localhost/api/v1/health", {
        headers: authHeaders(token),
      });
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Host is still starting; retry until the deadline.
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for Host health\n${logs.join("")}`);
}

async function waitForTcpHealth(baseUrl, child, logs, token) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    assertHostAlive(child, logs);
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Host startup must be polled sequentially.
      const response = await fetch(`${baseUrl}/api/v1/health`, {
        headers: authHeaders(token),
      });
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Host is still starting; retry until the deadline.
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for Host health\n${logs.join("")}`);
}

async function extensionRequest(
  localFetch,
  method,
  pathname,
  { body, credential } = {}
) {
  const headers = authHeaders(credential);
  const init = { headers, method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await localFetch(`http://localhost${pathname}`, init);
  const text = await response.text();
  return {
    status: response.status,
    value: text.length > 0 ? JSON.parse(text) : null,
  };
}

async function startHarness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omo-extension-unit-"));
  const socketPath = path.join(root, "extension.sock");
  const service = new ExtensionService({
    heartbeatIntervalMs: 400,
    heartbeatTimeoutMs: 800,
    hostId: crypto.randomUUID(),
    sweepIntervalMs: 50,
    ...options,
  });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    service
      .handle(request, response, url)
      .then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      })
      .catch(() => {
        if (!response.headersSent) {
          response.writeHead(500);
          response.end();
        }
      });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    async close() {
      service.dispose();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { force: true, recursive: true });
    },
    localFetch: createLocalEndpointFetch(socketPath),
    service,
    socketPath,
  };
}

function openCommandStream(socketPath, { credential, generation, instanceId }) {
  const pathname = `/api/v1/extension/commands?instanceId=${encodeURIComponent(
    instanceId
  )}&generation=${generation}`;
  const frames = [];
  const waiters = [];
  const opened = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const request = http.request(
    {
      headers: authHeaders(credential),
      method: "GET",
      path: pathname,
      socketPath,
    },
    (response) => {
      opened.resolve(response.statusCode);
      response.setEncoding("utf8");
      let buffer = "";
      response.on("data", (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf("\n\n");
        while (index !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of block.split("\n")) {
            if (line.startsWith("data: ")) {
              const frame = JSON.parse(line.slice(6));
              const waiter = waiters.shift();
              if (waiter) {
                waiter(frame);
              } else {
                frames.push(frame);
              }
            }
          }
          index = buffer.indexOf("\n\n");
        }
      });
      response.on("end", () => closed.resolve("end"));
      response.on("error", () => closed.resolve("error"));
    }
  );
  request.once("error", () => {
    opened.resolve(null);
    closed.resolve("error");
  });
  request.end();
  return {
    close: () => request.destroy(),
    closed: closed.promise,
    nextFrame(timeoutMs = 5000) {
      if (frames.length > 0) {
        return Promise.resolve(frames.shift());
      }
      return withTimeout(
        new Promise((resolve) => waiters.push(resolve)),
        timeoutMs,
        "timed out waiting for a command frame"
      );
    },
    opened: opened.promise,
  };
}

test("extension service registers, heartbeats, detaches and advances generation", async () => {
  const harness = await startHarness();
  try {
    const request = registerRequest();
    const registered = await harness.service.register(request);
    assert.equal(registered.ok, true);
    assert.equal(registered.generation, 1);
    assert.match(registered.credential, CREDENTIAL_PATTERN);
    assert.equal(registered.hostId, harness.service.hostId);
    assert.ok(registered.heartbeatIntervalMs >= 1000);

    const before = harness.service.executionState(request.sessionId);
    assert.equal(before.state, "native-attached");
    assert.equal(before.ownerInstanceId, request.instanceId);

    const heartbeat = await harness.service.heartbeat(
      { generation: 1, instanceId: request.instanceId },
      registered.credential
    );
    assert.equal(heartbeat.ok, true);
    assert.ok(heartbeat.expiresAt > Date.now());

    const detached = await harness.service.detach(
      {
        generation: 1,
        instanceId: request.instanceId,
        reason: "test-detach",
      },
      registered.credential
    );
    assert.equal(detached.ok, true);
    assert.equal(
      harness.service.executionState(request.sessionId).state,
      "detached"
    );
    assert.equal(harness.service.sendCommand(request.sessionId, {}), false);
  } finally {
    await harness.close();
  }
});

test("a live attachment blocks competing registers until it detaches", async () => {
  const harness = await startHarness();
  try {
    const request = registerRequest();
    const first = await harness.service.register(request);
    assert.equal(first.generation, 1);

    const competitor = registerRequest({ sessionId: request.sessionId });
    const rejected = await harness.service.register(competitor);
    assert.deepEqual(rejected, {
      ok: false,
      reason: "session_already_attached",
    });

    await harness.service.detach(
      { generation: 1, instanceId: request.instanceId },
      first.credential
    );
    const second = await harness.service.register(competitor);
    assert.equal(second.ok, true);
    assert.equal(second.generation, 2);
  } finally {
    await harness.close();
  }
});

test("stale generations are fenced from heartbeat, events, ack and detach", async () => {
  const harness = await startHarness();
  try {
    const request = registerRequest();
    const first = await harness.service.register(request);
    await harness.service.detach(
      { generation: 1, instanceId: request.instanceId },
      first.credential
    );
    const second = await harness.service.register(request);
    assert.equal(second.generation, 2);

    const { instanceId } = request;
    const staleHeartbeat = harness.service.heartbeat(
      { generation: 1, instanceId },
      first.credential
    );
    await assert.rejects(staleHeartbeat, (error) => error.status === 409);

    const staleEvents = harness.service.events(
      { events: [], generation: 1, instanceId },
      first.credential
    );
    await assert.rejects(staleEvents, (error) => error.status === 409);

    const staleAck = harness.service.ack(
      {
        commandSequence: 1,
        generation: 1,
        instanceId,
        requestId: "req-stale",
        status: "accepted",
      },
      first.credential
    );
    await assert.rejects(staleAck, (error) => error.status === 409);

    const staleDetach = harness.service.detach(
      { generation: 1, instanceId },
      first.credential
    );
    await assert.rejects(staleDetach, (error) => error.status === 409);

    const wrongCredential = harness.service.heartbeat(
      { generation: 2, instanceId },
      first.credential
    );
    await assert.rejects(wrongCredential, (error) => error.status === 401);

    const currentHeartbeat = await harness.service.heartbeat(
      { generation: 2, instanceId },
      second.credential
    );
    assert.equal(currentHeartbeat.generation, 2);
  } finally {
    await harness.close();
  }
});

test("detach is idempotent and never releases a newer generation", async () => {
  const harness = await startHarness();
  try {
    const request = registerRequest();
    const first = await harness.service.register(request);
    await harness.service.detach(
      { generation: 1, instanceId: request.instanceId },
      first.credential
    );
    const again = await harness.service.detach(
      { generation: 1, instanceId: request.instanceId },
      first.credential
    );
    assert.equal(again.ok, true);

    const second = await harness.service.register(request);
    assert.equal(second.generation, 2);
    const older = harness.service.detach(
      { generation: 1, instanceId: request.instanceId },
      first.credential
    );
    await assert.rejects(older, (error) => error.status === 409);
    assert.equal(
      harness.service.executionState(request.sessionId).state,
      "native-attached"
    );

    const detached = await harness.service.detach(
      { generation: 2, instanceId: request.instanceId },
      second.credential
    );
    assert.equal(detached.ok, true);
  } finally {
    await harness.close();
  }
});

test("event batches deduplicate native sequences and only emit fresh events", async () => {
  const harness = await startHarness();
  try {
    const request = registerRequest();
    const registered = await harness.service.register(request);
    const batch = {
      events: [
        nativeEvent(1, request.sessionId),
        nativeEvent(2, request.sessionId),
      ],
      generation: registered.generation,
      instanceId: request.instanceId,
    };
    const firstResult = await harness.service.events(
      batch,
      registered.credential
    );
    assert.deepEqual(firstResult, { accepted: 2, duplicates: 0, ok: true });

    const secondResult = await harness.service.events(
      batch,
      registered.credential
    );
    assert.deepEqual(secondResult, { accepted: 0, duplicates: 2, ok: true });

    const mismatch = harness.service.events(
      {
        events: [nativeEvent(3, "other-session")],
        generation: registered.generation,
        instanceId: request.instanceId,
      },
      registered.credential
    );
    await assert.rejects(mismatch, (error) => error.status === 400);
  } finally {
    await harness.close();
  }
});

test("onNativeEvent and onDetach hooks observe deduplicated state", async () => {
  const emitted = [];
  const detached = Promise.withResolvers();
  const harness = await startHarness({
    onDetach: (sessionId, attachment, reason) =>
      detached.resolve({ attachment, reason, sessionId }),
    onNativeEvent: (attachment, event) => emitted.push([attachment, event]),
  });
  try {
    const request = registerRequest();
    const registered = await harness.service.register(request);
    const batch = {
      events: [
        nativeEvent(1, request.sessionId),
        nativeEvent(1, request.sessionId),
      ],
      generation: registered.generation,
      instanceId: request.instanceId,
    };
    await harness.service.events(batch, registered.credential);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0][1].nativeSequence, 1);
    assert.equal(emitted[0][0].credential, undefined);

    const heartbeat = harness.service.heartbeat(
      { generation: 1, instanceId: request.instanceId },
      registered.credential
    );
    await heartbeat;
    await harness.service.detach(
      { generation: 1, instanceId: request.instanceId },
      registered.credential
    );
    const hookResult = await withTimeout(
      detached.promise,
      2000,
      "onDetach was not called"
    );
    assert.equal(hookResult.reason, "detached");
    assert.equal(hookResult.sessionId, request.sessionId);
    assert.equal(hookResult.attachment.credential, undefined);
  } finally {
    await harness.close();
  }
});

test("heartbeat expiry releases the attachment, closes SSE and notifies onDetach", async () => {
  const detached = Promise.withResolvers();
  const harness = await startHarness({
    heartbeatTimeoutMs: 150,
    onDetach: (sessionId, attachment, reason) =>
      detached.resolve({ attachment, reason, sessionId }),
    sweepIntervalMs: 20,
  });
  try {
    const request = registerRequest();
    const registered = await harness.service.register(request);
    const stream = openCommandStream(harness.socketPath, {
      credential: registered.credential,
      generation: registered.generation,
      instanceId: request.instanceId,
    });
    assert.equal(await stream.opened, 200);

    const reason = await withTimeout(
      detached.promise.then((value) => value.reason),
      3000,
      "attachment did not expire"
    );
    assert.equal(reason, "heartbeat-timeout");
    assert.equal(
      await withTimeout(stream.closed, 3000, "expired SSE stream stayed open"),
      "end"
    );

    const reregistered = await harness.service.register(request);
    assert.equal(reregistered.ok, true);
    assert.equal(reregistered.generation, 2);
  } finally {
    await harness.close();
  }
});

test("command stream delivers exactly the frames written through sendCommand", async () => {
  const harness = await startHarness();
  try {
    const request = registerRequest();
    const registered = await harness.service.register(request);
    const stream = openCommandStream(harness.socketPath, {
      credential: registered.credential,
      generation: registered.generation,
      instanceId: request.instanceId,
    });
    assert.equal(await stream.opened, 200);

    const command = {
      commandSequence: 1,
      requestId: "req-1",
      text: "hello from the daemon",
      type: "prompt",
    };
    assert.equal(harness.service.sendCommand(request.sessionId, command), true);
    assert.deepEqual(await stream.nextFrame(), command);
    stream.close();
  } finally {
    await harness.close();
  }
});

test("a same-generation reconnect replaces the previous command stream", async () => {
  const harness = await startHarness();
  try {
    const request = registerRequest();
    const registered = await harness.service.register(request);
    const options = {
      credential: registered.credential,
      generation: registered.generation,
      instanceId: request.instanceId,
    };
    const first = openCommandStream(harness.socketPath, options);
    assert.equal(await first.opened, 200);
    const second = openCommandStream(harness.socketPath, options);
    assert.equal(await second.opened, 200);
    assert.equal(await first.closed, "end");

    assert.equal(
      harness.service.sendCommand(request.sessionId, {
        commandSequence: 2,
        requestId: "req-2",
        type: "abort",
      }),
      true
    );
    assert.deepEqual(await second.nextFrame(), {
      commandSequence: 2,
      requestId: "req-2",
      type: "abort",
    });

    const stale = openCommandStream(harness.socketPath, {
      ...options,
      generation: registered.generation + 1,
    });
    assert.equal(await stale.opened, 409);
    const unauthorized = openCommandStream(harness.socketPath, {
      ...options,
      credential: "",
    });
    assert.equal(await unauthorized.opened, 401);
    second.close();
  } finally {
    await harness.close();
  }
});

test("malformed bodies, unknown instances and unknown routes fail closed", async () => {
  const harness = await startHarness();
  try {
    const missingAuth = await extensionRequest(
      harness.localFetch,
      "POST",
      "/api/v1/extension/heartbeat",
      { body: { generation: 1, instanceId: crypto.randomUUID() } }
    );
    assert.equal(missingAuth.status, 401);

    const malformed = await extensionRequest(
      harness.localFetch,
      "POST",
      "/api/v1/extension/heartbeat",
      { credential: "deadbeef" }
    );
    assert.equal(malformed.status, 400);

    const invalidRegister = await extensionRequest(
      harness.localFetch,
      "POST",
      "/api/v1/extension/register",
      { body: { instanceId: "not-a-uuid" } }
    );
    assert.equal(invalidRegister.status, 400);
    assert.match(invalidRegister.value.error, INVALID_REGISTER_PATTERN);

    const unknown = await extensionRequest(
      harness.localFetch,
      "POST",
      "/api/v1/extension/heartbeat",
      {
        body: { generation: 1, instanceId: crypto.randomUUID() },
        credential: "a".repeat(64),
      }
    );
    assert.equal(unknown.status, 404);

    const unknownRoute = await extensionRequest(
      harness.localFetch,
      "GET",
      "/api/v1/extension/nope"
    );
    assert.equal(unknownRoute.status, 404);
  } finally {
    await harness.close();
  }
});

test("extension channel is socket-only and uses the durable hostId", {
  skip: SKIP_WINDOWS,
}, async () => {
  const layout = createLayout("wiring");
  const endpoint = resolveLocalEndpoint({
    dataDir: layout.dataDir,
    platform: process.platform,
  });
  const { child, logs } = spawnHost({
    ...layout,
    token: PUBLIC_TOKEN,
    transport: "socket",
  });
  try {
    const localFetch = createLocalEndpointFetch(endpoint.path);
    await waitForSocketHealth(localFetch, child, logs, PUBLIC_TOKEN);
    const identity = JSON.parse(
      fs.readFileSync(path.join(layout.dataDir, "host.json"), "utf8")
    );

    const request = registerRequest();
    const registered = await extensionRequest(
      localFetch,
      "POST",
      "/api/v1/extension/register",
      { body: request }
    );
    assert.equal(registered.status, 200);
    assert.equal(registered.value.ok, true);
    assert.equal(registered.value.generation, 1);
    assert.equal(registered.value.hostId, identity.hostId);
    assert.match(registered.value.credential, CREDENTIAL_PATTERN);

    const heartbeat = await extensionRequest(
      localFetch,
      "POST",
      "/api/v1/extension/heartbeat",
      {
        body: {
          generation: registered.value.generation,
          instanceId: request.instanceId,
        },
        credential: registered.value.credential,
      }
    );
    assert.equal(heartbeat.status, 200);
    assert.equal(heartbeat.value.ok, true);

    const publicApi = await localFetch("http://localhost/api/v1/cwd");
    assert.equal(publicApi.status, 401);

    const detached = await extensionRequest(
      localFetch,
      "POST",
      "/api/v1/extension/detach",
      {
        body: {
          generation: registered.value.generation,
          instanceId: request.instanceId,
        },
        credential: registered.value.credential,
      }
    );
    assert.equal(detached.status, 200);
    assert.equal(detached.value.ok, true);
  } finally {
    await stopChild(child);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("a real host expires an attachment that stops heartbeating", {
  skip: SKIP_WINDOWS,
}, async () => {
  const layout = createLayout("expiry");
  const endpoint = resolveLocalEndpoint({
    dataDir: layout.dataDir,
    platform: process.platform,
  });
  const { child, logs } = spawnHost({
    ...layout,
    extraEnv: {
      OMO_EXTENSION_HEARTBEAT_INTERVAL_MS: "150",
      OMO_EXTENSION_HEARTBEAT_TIMEOUT_MS: "300",
    },
    token: "",
    transport: "socket",
  });
  try {
    const localFetch = createLocalEndpointFetch(endpoint.path);
    await waitForSocketHealth(localFetch, child, logs, "");
    const request = registerRequest();
    const registered = await extensionRequest(
      localFetch,
      "POST",
      "/api/v1/extension/register",
      { body: request }
    );
    assert.equal(registered.value.ok, true);

    const stream = openCommandStream(endpoint.path, {
      credential: registered.value.credential,
      generation: registered.value.generation,
      instanceId: request.instanceId,
    });
    assert.equal(await stream.opened, 200);

    const deadline = Date.now() + 10_000;
    let next;
    while (Date.now() < deadline) {
      // biome-ignore lint/performance/noAwaitInLoops: Registration must be retried sequentially until the lease expires.
      next = await extensionRequest(
        localFetch,
        "POST",
        "/api/v1/extension/register",
        { body: request }
      );
      if (next.value?.ok) {
        break;
      }
      await delay(POLL_INTERVAL_MS);
    }
    assert.equal(next?.value?.ok, true);
    assert.equal(next.value.generation, 2);
    assert.equal(
      await withTimeout(stream.closed, 3000, "expired SSE stream stayed open"),
      "end"
    );
  } finally {
    await stopChild(child);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("a daemon restart invalidates instance credentials", {
  skip: SKIP_WINDOWS,
}, async () => {
  const layout = createLayout("restart");
  const endpoint = resolveLocalEndpoint({
    dataDir: layout.dataDir,
    platform: process.platform,
  });
  const request = registerRequest();
  const firstHost = spawnHost({ ...layout, token: "", transport: "socket" });
  let credential;
  try {
    const localFetch = createLocalEndpointFetch(endpoint.path);
    await waitForSocketHealth(localFetch, firstHost.child, firstHost.logs, "");
    const registered = await extensionRequest(
      localFetch,
      "POST",
      "/api/v1/extension/register",
      { body: request }
    );
    assert.equal(registered.value.ok, true);
    ({ credential } = registered.value);
  } finally {
    const exited = waitForExit(firstHost.child);
    firstHost.child.kill("SIGTERM");
    await exited;
  }

  const secondHost = spawnHost({ ...layout, token: "", transport: "socket" });
  try {
    const localFetch = createLocalEndpointFetch(endpoint.path);
    await waitForSocketHealth(
      localFetch,
      secondHost.child,
      secondHost.logs,
      ""
    );
    const before = await extensionRequest(
      localFetch,
      "POST",
      "/api/v1/extension/heartbeat",
      {
        body: { generation: 1, instanceId: request.instanceId },
        credential,
      }
    );
    assert.ok(
      [401, 404].includes(before.status),
      `unexpected ${before.status}`
    );

    const again = await extensionRequest(
      localFetch,
      "POST",
      "/api/v1/extension/register",
      { body: request }
    );
    assert.equal(again.value.ok, true);
    assert.equal(again.value.generation, 1);
    assert.notEqual(again.value.credential, credential);

    const after = await extensionRequest(
      localFetch,
      "POST",
      "/api/v1/extension/heartbeat",
      {
        body: { generation: 1, instanceId: request.instanceId },
        credential,
      }
    );
    assert.equal(after.status, 401);
  } finally {
    await stopChild(secondHost.child);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("TCP-mode daemons do not expose the extension channel", async () => {
  const layout = createLayout("tcp");
  const port = await freePort();
  const baseUrl = `http://${HOST_ADDRESS}:${port}`;
  const { child, logs } = spawnHost({
    ...layout,
    port,
    token: PUBLIC_TOKEN,
    transport: "tcp",
  });
  try {
    await waitForTcpHealth(baseUrl, child, logs, PUBLIC_TOKEN);
    const postPaths = ["ack", "detach", "events", "heartbeat", "register"];
    for (const name of postPaths) {
      // biome-ignore lint/performance/noAwaitInLoops: Each route is asserted sequentially.
      const response = await fetch(`${baseUrl}/api/v1/extension/${name}`, {
        body: "{}",
        headers: { Authorization: `Bearer ${PUBLIC_TOKEN}` },
        method: "POST",
      });
      assert.equal(response.status, 404, `${name} must not exist on TCP`);
    }
    const commands = await fetch(
      `${baseUrl}/api/v1/extension/commands?instanceId=unknown&generation=1`
    );
    assert.equal(commands.status, 404);
  } finally {
    await stopChild(child);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});
