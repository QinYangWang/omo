import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalEndpointFetch } from "../cli/local-transport.mjs";
import { HttpHostClient } from "../packages/client-core/dist/index.js";
import { scrubOmoEnv } from "./spawn-env.mjs";

const require = createRequire(import.meta.url);
const { EventStore } = require("../server/event-store.cjs");
const {
  appendExecutionStateEvent,
  ExecutionBroker,
} = require("../server/execution-broker.cjs");
const { ExtensionService } = require("../server/extension-service.cjs");
const { resolveLocalEndpoint } = require("../server/local-endpoint.cjs");
const { createNativeEventHandler } = require("../server/native-events.cjs");
const { PiService } = require("../server/pi-service.cjs");

const SESSION_ID = "session-native-replay";
const EXECUTION_EVENT_TYPE = "omo_execution_state";
const ROOT = path.resolve(import.meta.dirname, "..");
const HOST_ENTRY = path.join(ROOT, "server", "index.cjs");
const HEALTH_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 50;
const SKIP_WINDOWS =
  process.platform === "win32"
    ? "Unix domain sockets are unavailable on Windows"
    : false;

// The realistic native lifecycle the Extension forwards (design §6.1). The
// payloads mirror what the Pi SDK emits closely enough for the TypeBox
// JsonValue contract, so the real `HttpHostClient` can parse them.
const REALISTIC_LIFECYCLE = [
  ["session_start", { sessionId: SESSION_ID }],
  ["agent_start", {}],
  ["turn_start", { turnIndex: 0 }],
  ["message_start", { message: { content: "", role: "assistant" } }],
  [
    "message_update",
    { assistantMessageEvent: { delta: "Hel", type: "text_delta" } },
  ],
  [
    "message_update",
    { assistantMessageEvent: { delta: "lo", type: "text_delta" } },
  ],
  ["message_end", { message: { content: "Hello", role: "assistant" } }],
  ["turn_end", { turnIndex: 0 }],
  ["agent_end", {}],
  ["agent_settled", {}],
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `[1, 2, ..., length]`. */
const contiguous = (length) => Array.from({ length }, (_, index) => index + 1);

function registerRequest(sessionId, overrides = {}) {
  return {
    capabilities: ["commands", "events"],
    channelVersion: 1,
    extensionVersion: "0.1.0-test",
    instanceId: crypto.randomUUID(),
    piVersion: "0.85.0-test",
    sessionId,
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

function realisticNativeEvents(sessionId) {
  return REALISTIC_LIFECYCLE.map(([event, payload], index) =>
    nativeEvent(index + 1, sessionId, { event, payload })
  );
}

/** Mock AgentSession shape `PiService` needs; no runtime is ever opened here. */
function createMockRuntime(sessionId) {
  const state = { openSessionCalls: [], sessions: new Map() };
  const adapter = {
    getModelRuntime: () =>
      Promise.resolve({
        getModel: () => ({ id: "test-model", name: "Test", provider: "test" }),
      }),
    openSession(input) {
      const listeners = new Set();
      const session = {
        getContextUsage: () => null,
        isIdle: true,
        isStreaming: false,
        model: { id: "test-model", name: "Test", provider: "test" },
        prompt: () => Promise.resolve(),
        sessionFile: input.sessionPath ?? "/sessions/mock.jsonl",
        sessionId,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      state.openSessionCalls.push(input);
      state.sessions.set(sessionId, session);
      return { release: () => listeners.clear(), session };
    },
    openSessionDocument: () => ({
      getBranch: () => [],
      getSessionId: () => sessionId,
    }),
  };
  return { adapter, state };
}

/**
 * Mirrors `streamEvents` in `server/host.cjs` exactly: replay
 * `events.list(sessionId, after)`, then attach a live
 * `events.subscribe(sessionId, send)`. The stale-cursor resync guard is the
 * same one the real handler applies, and scenario 3 exercises the real
 * handler through a spawned Host.
 */
function streamSessionEvents(events, req, res, sessionId, after) {
  const latest = events.latestSequence(sessionId);
  let cursor = after;
  if (sessionId === "__providers") {
    cursor = Math.min(after, latest);
  } else if (after > latest) {
    cursor = 0;
  }
  res.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 1000\n\n");
  const send = (record) =>
    res.write(
      `id: ${record.sequence}\nevent: message\ndata: ${JSON.stringify(record)}\n\n`
    );
  for (const record of events.list(sessionId, cursor)) {
    send(record);
  }
  const unsubscribe = events.subscribe(sessionId, send);
  const heartbeat = setInterval(
    () => res.write(`: heartbeat ${Date.now()}\n\n`),
    15_000
  );
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

/**
 * In-process wiring that mirrors `initializeHost`: real EventStore, real
 * ExtensionService (with the E4-001 attach/detach transition hooks), real
 * PiService with a mocked runtime, a real ExecutionBroker, the native event
 * mapper and a loopback HTTP server that serves the actual extension routes
 * plus the `/api/v1/events` SSE route.
 */
async function createHarness(options = {}) {
  const sessionId = options.sessionId ?? SESSION_ID;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-native-replay-"));
  const events = new EventStore(dataDir);
  const workspace = { resolveExisting: async (value) => value };
  const { adapter, state } = createMockRuntime(sessionId);
  const service = new PiService(events, workspace, workspace, adapter);
  let broker;
  let nativeEventHandler;
  const recordExecutionState = (id) =>
    appendExecutionStateEvent(events, broker, id);
  const extensionService = new ExtensionService({
    canAttach: (id) => broker.canAttach(id),
    heartbeatIntervalMs: 1000,
    heartbeatTimeoutMs: 60_000,
    hostId: crypto.randomUUID(),
    onAttach: (id) => recordExecutionState(id),
    onAttachConfirm: (id) => broker.onAttachConfirm(id),
    onDetach: (id) => {
      broker.onDetach(id);
      recordExecutionState(id);
    },
    onNativeEvent: (attachment, event) =>
      nativeEventHandler?.handle(attachment, event),
    sweepIntervalMs: 1000,
  });
  broker = new ExecutionBroker({
    extensionService,
    hasHeadlessRuntime: (id) => service.hasRuntime(id),
    isHeadlessStreaming: (id) => service.isRuntimeStreaming(id),
    releaseIdleRuntime: (id) => service.releaseIdleRuntime(id),
  });
  service.setExecutionBroker(broker);
  nativeEventHandler = createNativeEventHandler({ events });

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/api/v1/events") {
      streamSessionEvents(
        events,
        request,
        response,
        url.searchParams.get("sessionId"),
        Number(
          request.headers["last-event-id"] || url.searchParams.get("after") || 0
        )
      );
      return;
    }
    extensionService
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
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    broker,
    async close() {
      extensionService.dispose();
      service.dispose();
      events.close();
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      await closed;
      fs.rmSync(dataDir, { force: true, recursive: true });
    },
    dataDir,
    events,
    extensionService,
    nativeEventHandler,
    service,
    state,
  };
}

async function registerExtension(harness, request) {
  const response = await fetch(`${harness.baseUrl}/api/v1/extension/register`, {
    body: JSON.stringify(request),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function postEvents(
  harness,
  { credential, events, generation, instanceId }
) {
  const response = await fetch(`${harness.baseUrl}/api/v1/extension/events`, {
    body: JSON.stringify({ events, generation, instanceId }),
    headers: {
      Authorization: `Bearer ${credential}`,
      Connection: "close",
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const text = await response.text();
  return {
    status: response.status,
    value: text.length > 0 ? JSON.parse(text) : null,
  };
}

async function detachExtension(
  harness,
  { credential, generation, instanceId, reason = "test-detach" }
) {
  const response = await fetch(`${harness.baseUrl}/api/v1/extension/detach`, {
    body: JSON.stringify({ generation, instanceId, reason }),
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  assert.equal(response.status, 200);
  return response.json();
}

/**
 * Subscribes with the real `HttpHostClient` (same SSE parser and cursor
 * tracking the Web/Desktop clients use) and resolves once `count` events have
 * been delivered, so no wall-clock wait is required.
 */
function collectEvents(client, sessionId, after, count, timeoutMs = 5000) {
  const received = [];
  const resolved = Promise.withResolvers();
  let subscription;
  const timer = setTimeout(() => {
    subscription?.close();
    resolved.reject(
      new Error(`timed out waiting for ${count} events after ${after}`)
    );
  }, timeoutMs);
  subscription = client.subscribeSession(sessionId, after, (event) => {
    received.push(event);
    if (received.length >= count) {
      clearTimeout(timer);
      subscription.close();
      resolved.resolve(received);
    }
  });
  return resolved.promise;
}

/**
 * Reads raw SSE frames from a Host event stream. Used for the cross-epoch
 * scenario, where the production `HttpHostClient` intentionally drops any
 * replayed sequence that is `<=` its own cursor and therefore cannot observe
 * a full replay (it has no epoch/reset signal telling it the stream
 * restarted). The raw reader asserts what the HTTP handler actually emits.
 */
async function collectRawSse(
  localFetch,
  sessionId,
  after,
  count,
  timeoutMs = 5000
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const records = [];
  const query = new URLSearchParams({ after: String(after), sessionId });
  try {
    const response = await localFetch(
      `http://localhost/api/v1/events?${query}`,
      {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      }
    );
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (records.length < count) {
      // biome-ignore lint/performance/noAwaitInLoops: frames are ordered.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = block
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (dataLine) {
          records.push(JSON.parse(dataLine.slice(6)));
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    return records;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Collects SSE frames for a fixed window and returns them. Unlike
 * `collectRawSse`, reaching the timeout with zero frames is the expected
 * outcome, so the abort is swallowed instead of failing the read.
 */
async function readSseFor(localFetch, sessionId, after, durationMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), durationMs);
  const records = [];
  const query = new URLSearchParams({ after: String(after), sessionId });
  try {
    const response = await localFetch(
      `http://localhost/api/v1/events?${query}`,
      {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      }
    );
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: frames are ordered.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = block
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (dataLine) {
          records.push(JSON.parse(dataLine.slice(6)));
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return records;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: short deterministic poll.
    await delay(10);
  }
  throw new Error("condition was not met before the timeout");
}

function createLayout(label) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `omo-native-replay-${label}-`)
  );
  const agentDir = path.join(root, "agent");
  const dataDir = path.join(root, "data");
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { agentDir, dataDir, root, workspaceDir };
}

function spawnHost({ agentDir, dataDir, workspaceDir }) {
  const child = spawn(process.execPath, [HOST_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...scrubOmoEnv,
      OMO_DATA_DIR: dataDir,
      OMO_LOCAL_SOCKET: "",
      OMO_TOKEN: "",
      OMO_TRANSPORT: "socket",
      OMO_WORKSPACE_ROOTS: workspaceDir,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  return { child, logs };
}

async function waitForSocketHealth(localFetch, child, logs) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Host exited before health\n${logs.join("")}`);
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: health is polled sequentially.
      const response = await localFetch("http://localhost/api/v1/health");
      if (response.ok) {
        return;
      }
    } catch {
      // Host is still starting; retry until the deadline.
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for Host health\n${logs.join("")}`);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(
      () => reject(new Error("Host did not exit within the timeout")),
      EXIT_TIMEOUT_MS
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = waitForExit(child);
  child.kill("SIGTERM");
  await exited;
}

async function localJson(localFetch, method, pathname, { body, credential }) {
  const headers = {};
  if (credential) {
    headers.Authorization = `Bearer ${credential}`;
  }
  const init = { headers, method };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await localFetch(`http://localhost${pathname}`, init);
  const text = await response.text();
  return {
    status: response.status,
    value: text.length > 0 ? JSON.parse(text) : null,
  };
}

function removeEventLog(dataDir) {
  for (const name of ["omo.db", "omo.db-shm", "omo.db-wal"]) {
    fs.rmSync(path.join(dataDir, name), { force: true });
  }
}

test("native events persist contiguously and SSE replays exactly the missing delta", async () => {
  const harness = await createHarness();
  const client = new HttpHostClient({
    baseUrl: harness.baseUrl,
    reconnectDelayMs: 20,
  });
  try {
    const request = registerRequest(SESSION_ID);
    const registered = await registerExtension(harness, request);
    assert.equal(registered.ok, true);

    const forwarded = realisticNativeEvents(SESSION_ID);
    const posted = await postEvents(harness, {
      credential: registered.credential,
      events: forwarded,
      generation: registered.generation,
      instanceId: request.instanceId,
    });
    assert.deepEqual(posted.value, {
      accepted: forwarded.length,
      duplicates: 0,
      ok: true,
    });

    const persisted = harness.events.list(SESSION_ID);
    // Attach transition first (E4-001), then the native lifecycle in order.
    assert.deepEqual(
      persisted.map((record) => record.sequence),
      contiguous(persisted.length)
    );
    assert.deepEqual(
      persisted.map((record) => record.type),
      [EXECUTION_EVENT_TYPE, ...REALISTIC_LIFECYCLE.map(([event]) => event)]
    );

    const consumed = 5;
    const backlog = harness.events.list(SESSION_ID, 0);
    const expectedTail = backlog.slice(consumed);

    // Reconnect at `after=consumed` as a client that already rendered the
    // first K events would.
    const replayed = await collectEvents(
      client,
      SESSION_ID,
      consumed,
      expectedTail.length
    );
    assert.deepEqual(
      replayed.map((record) => record.sequence),
      expectedTail.map((record) => record.sequence)
    );
    assert.deepEqual(
      replayed.map((record) => record.type),
      expectedTail.map((record) => record.type)
    );
    assert.deepEqual(
      replayed.map((record) => record.sequence),
      contiguous(replayed.length).map((value) => value + consumed)
    );
    // No first-K repetition.
    const consumedSequences = new Set(
      backlog.slice(0, consumed).map((record) => record.sequence)
    );
    assert.equal(
      replayed.some((record) => consumedSequences.has(record.sequence)),
      false
    );

    // The HTTP replay is exactly `EventStore.list(after)`, the query the
    // handler uses; `subscribe` has no cursor option and only delivers events
    // appended after registration.
    assert.deepEqual(
      replayed.map((record) => record.id),
      harness.events.list(SESSION_ID, consumed).map((record) => record.id)
    );
    const live = [];
    const unsubscribe = harness.events.subscribe(SESSION_ID, (record) =>
      live.push(record.sequence)
    );
    const beforeLive = harness.events.latestSequence(SESSION_ID);
    await postEvents(harness, {
      credential: registered.credential,
      events: [nativeEvent(999, SESSION_ID, { event: "agent_end" })],
      generation: registered.generation,
      instanceId: request.instanceId,
    });
    unsubscribe();
    assert.deepEqual(live, [beforeLive + 1]);
  } finally {
    await harness.close();
  }
});

test("a cursor at the tail replays zero events and stays live", async () => {
  const harness = await createHarness();
  const client = new HttpHostClient({
    baseUrl: harness.baseUrl,
    reconnectDelayMs: 20,
  });
  try {
    const request = registerRequest(SESSION_ID);
    const registered = await registerExtension(harness, request);
    await postEvents(harness, {
      credential: registered.credential,
      events: realisticNativeEvents(SESSION_ID).slice(0, 3),
      generation: registered.generation,
      instanceId: request.instanceId,
    });
    const latest = harness.events.latestSequence(SESSION_ID);

    const received = [];
    const subscription = client.subscribeSession(SESSION_ID, latest, (event) =>
      received.push(event)
    );
    await waitFor(() => harness.events.emitter.listenerCount(SESSION_ID) > 0);
    assert.deepEqual(received, []);

    const posted = await postEvents(harness, {
      credential: registered.credential,
      events: [
        nativeEvent(4, SESSION_ID, {
          event: "turn_end",
          payload: { turnIndex: 0 },
        }),
      ],
      generation: registered.generation,
      instanceId: request.instanceId,
    });
    assert.deepEqual(posted.value, { accepted: 1, duplicates: 0, ok: true });

    await waitFor(() => received.length === 1);
    assert.deepEqual(
      received.map((record) => [record.sequence, record.type]),
      [[latest + 1, "turn_end"]]
    );
    subscription.close();
  } finally {
    await harness.close();
  }
});

test("a new EventStore on the same data dir preserves sequences (no epoch reset)", async () => {
  const harness = await createHarness();
  const { dataDir } = harness;
  try {
    const request = registerRequest(SESSION_ID);
    const registered = await registerExtension(harness, request);
    await postEvents(harness, {
      credential: registered.credential,
      events: realisticNativeEvents(SESSION_ID),
      generation: registered.generation,
      instanceId: request.instanceId,
    });
    const before = harness.events.list(SESSION_ID);
    assert.equal(harness.events.latestSequence(SESSION_ID), before.length);

    // Simulate a daemon restart against the same data directory: the durable
    // log keeps its sequence numbering, so an `after` cursor stays valid.
    harness.events.close();
    const reopened = new EventStore(dataDir);
    try {
      assert.equal(reopened.latestSequence(SESSION_ID), before.length);
      assert.deepEqual(
        reopened.list(SESSION_ID).map((record) => record.id),
        before.map((record) => record.id)
      );
    } finally {
      reopened.close();
    }
  } finally {
    await harness.close();
  }
});

test("re-posting the same (generation, nativeSequence) batch appends once", async () => {
  const harness = await createHarness();
  try {
    const request = registerRequest(SESSION_ID);
    const registered = await registerExtension(harness, request);
    const events = realisticNativeEvents(SESSION_ID).slice(0, 3);
    const batch = {
      credential: registered.credential,
      events,
      generation: registered.generation,
      instanceId: request.instanceId,
    };

    const first = await postEvents(harness, batch);
    assert.deepEqual(first.value, { accepted: 3, duplicates: 0, ok: true });
    const afterFirst = harness.events.latestSequence(SESSION_ID);

    const second = await postEvents(harness, batch);
    assert.deepEqual(second.value, { accepted: 0, duplicates: 3, ok: true });
    assert.equal(harness.events.latestSequence(SESSION_ID), afterFirst);

    // A partially overlapping batch appends only the fresh event.
    const overlap = await postEvents(harness, {
      ...batch,
      events: [
        events[2],
        nativeEvent(4, SESSION_ID, {
          event: "message_end",
          payload: { message: { content: "Hello", role: "assistant" } },
        }),
      ],
    });
    assert.deepEqual(overlap.value, { accepted: 1, duplicates: 1, ok: true });
    assert.deepEqual(
      harness.events.list(SESSION_ID).map((record) => record.sequence),
      contiguous(afterFirst + 1)
    );
  } finally {
    await harness.close();
  }
});

test("re-attach with a new generation appends after gen-1, emits one transition and fences the old generation", async () => {
  const harness = await createHarness();
  try {
    const request = registerRequest(SESSION_ID);
    const gen1 = await registerExtension(harness, request);
    await postEvents(harness, {
      credential: gen1.credential,
      events: realisticNativeEvents(SESSION_ID).slice(0, 4),
      generation: gen1.generation,
      instanceId: request.instanceId,
    });
    const gen1Events = harness.events.list(SESSION_ID).slice(1);
    assert.deepEqual(
      gen1Events.map((record) => record.type),
      REALISTIC_LIFECYCLE.slice(0, 4).map(([event]) => event)
    );

    await detachExtension(harness, {
      credential: gen1.credential,
      generation: gen1.generation,
      instanceId: request.instanceId,
    });

    // Old generation is fenced at the HTTP level while no owner exists.
    const fenced = await postEvents(harness, {
      credential: gen1.credential,
      events: [
        nativeEvent(90, SESSION_ID, {
          event: "message_update",
          payload: { marker: "gen1-after-detach" },
        }),
      ],
      generation: gen1.generation,
      instanceId: request.instanceId,
    });
    assert.equal(fenced.status, 409);

    const gen2 = await registerExtension(
      harness,
      registerRequest(SESSION_ID, { instanceId: request.instanceId })
    );
    assert.equal(gen2.generation, 2);

    const gen2Events = [
      nativeEvent(1, SESSION_ID, {
        event: "turn_start",
        payload: { turnIndex: 1 },
      }),
      nativeEvent(2, SESSION_ID, {
        event: "message_update",
        payload: {
          assistantMessageEvent: { delta: "second", type: "text_delta" },
        },
      }),
    ];
    const posted = await postEvents(harness, {
      credential: gen2.credential,
      events: gen2Events,
      generation: gen2.generation,
      instanceId: request.instanceId,
    });
    assert.deepEqual(posted.value, { accepted: 2, duplicates: 0, ok: true });

    const all = harness.events.list(SESSION_ID);
    assert.deepEqual(
      all.map((record) => record.sequence),
      contiguous(all.length)
    );

    // Gen-1 events survive intact and ordered; gen-2 events append after the
    // new attach transition.
    assert.deepEqual(
      all.slice(1, 1 + gen1Events.length).map((record) => record.id),
      gen1Events.map((record) => record.id)
    );
    assert.deepEqual(
      all.slice(-2).map((record) => record.type),
      gen2Events.map((event) => event.event)
    );

    // Exactly two attach transitions (gen-1 + gen-2) and one detach.
    const attachTransitions = all.filter(
      (record) =>
        record.type === EXECUTION_EVENT_TYPE &&
        record.payload.state === "native-attached"
    );
    const detachTransitions = all.filter(
      (record) =>
        record.type === EXECUTION_EVENT_TYPE &&
        record.payload.state === "detached"
    );
    assert.equal(attachTransitions.length, 2);
    assert.equal(detachTransitions.length, 1);
    assert.deepEqual(attachTransitions[1].payload, {
      generation: 2,
      ownerInstanceId: request.instanceId,
      state: "native-attached",
      type: EXECUTION_EVENT_TYPE,
    });
    // The fenced event never reached the log.
    assert.equal(
      all.some((record) => record.payload?.marker === "gen1-after-detach"),
      false
    );

    // A late old-generation event after the new attach is also fenced.
    const late = await postEvents(harness, {
      credential: gen1.credential,
      events: [nativeEvent(91, SESSION_ID, { event: "agent_end" })],
      generation: gen1.generation,
      instanceId: request.instanceId,
    });
    assert.equal(late.status, 409);
    assert.equal(harness.events.latestSequence(SESSION_ID), all.length);
  } finally {
    await harness.close();
  }
});

test("an event in the detach window is fenced without wasting a sequence", async () => {
  const harness = await createHarness();
  try {
    const request = registerRequest(SESSION_ID);
    const gen1 = await registerExtension(harness, request);
    await postEvents(harness, {
      credential: gen1.credential,
      events: [
        nativeEvent(1, SESSION_ID, {
          event: "turn_start",
          payload: { turnIndex: 0 },
        }),
      ],
      generation: gen1.generation,
      instanceId: request.instanceId,
    });
    await detachExtension(harness, {
      credential: gen1.credential,
      generation: gen1.generation,
      instanceId: request.instanceId,
    });

    const beforeFenced = harness.events.latestSequence(SESSION_ID);
    const fenced = await postEvents(harness, {
      credential: gen1.credential,
      events: [
        nativeEvent(2, SESSION_ID, {
          event: "message_update",
          payload: { marker: "detach-window" },
        }),
      ],
      generation: gen1.generation,
      instanceId: request.instanceId,
    });
    assert.equal(fenced.status, 409);
    assert.equal(harness.events.latestSequence(SESSION_ID), beforeFenced);
    assert.equal(
      harness.events
        .list(SESSION_ID)
        .some((record) => record.payload?.marker === "detach-window"),
      false
    );

    const gen2 = await registerExtension(harness, request);
    assert.equal(gen2.generation, 2);
    const afterAttach = harness.events.latestSequence(SESSION_ID);
    await postEvents(harness, {
      credential: gen2.credential,
      events: [
        nativeEvent(1, SESSION_ID, {
          event: "turn_start",
          payload: { turnIndex: 1 },
        }),
      ],
      generation: gen2.generation,
      instanceId: request.instanceId,
    });

    const all = harness.events.list(SESSION_ID);
    assert.deepEqual(
      all.map((record) => record.sequence),
      contiguous(all.length)
    );
    // The fenced event consumed no sequence: the next valid event is exactly
    // one past the gen-2 attach transition.
    assert.equal(all.at(-1).sequence, afterAttach + 1);
  } finally {
    await harness.close();
  }
});

test("repeated full replay is deterministic", async () => {
  const harness = await createHarness();
  const client = new HttpHostClient({
    baseUrl: harness.baseUrl,
    reconnectDelayMs: 20,
  });
  try {
    const request = registerRequest(SESSION_ID);
    const registered = await registerExtension(harness, request);
    await postEvents(harness, {
      credential: registered.credential,
      events: realisticNativeEvents(SESSION_ID),
      generation: registered.generation,
      instanceId: request.instanceId,
    });

    const first = harness.events.list(SESSION_ID);
    const second = harness.events.list(SESSION_ID, 0);
    assert.deepEqual(first, second);

    const streamedOnce = await collectEvents(
      client,
      SESSION_ID,
      0,
      first.length
    );
    const streamedTwice = await collectEvents(
      client,
      SESSION_ID,
      0,
      first.length
    );
    assert.deepEqual(
      streamedOnce.map((record) => record.id),
      streamedTwice.map((record) => record.id)
    );
    assert.deepEqual(
      streamedOnce.map((record) => record.sequence),
      first.map((record) => record.sequence)
    );
  } finally {
    await harness.close();
  }
});

test("a stale cursor across a wiped event-log epoch resyncs with a full replay", {
  skip: SKIP_WINDOWS,
}, async () => {
  const layout = createLayout("epoch");
  const endpoint = resolveLocalEndpoint({
    dataDir: layout.dataDir,
    platform: process.platform,
  });
  const request = registerRequest(SESSION_ID);
  let host = spawnHost(layout);
  try {
    const localFetch = createLocalEndpointFetch(endpoint.path);
    await waitForSocketHealth(localFetch, host.child, host.logs);
    const registered = await localJson(
      localFetch,
      "POST",
      "/api/v1/extension/register",
      { body: request }
    );
    assert.equal(registered.value.ok, true);
    const posted = await localJson(
      localFetch,
      "POST",
      "/api/v1/extension/events",
      {
        body: {
          events: realisticNativeEvents(SESSION_ID).slice(0, 6),
          generation: registered.value.generation,
          instanceId: request.instanceId,
        },
        credential: registered.value.credential,
      }
    );
    assert.deepEqual(posted.value, {
      accepted: 6,
      duplicates: 0,
      ok: true,
    });
  } finally {
    await stopChild(host.child);
  }

  // New event-log epoch: the durable log is recreated, so sequence numbering
  // restarts at 1 while the client still holds a cursor from the old epoch.
  removeEventLog(layout.dataDir);

  host = spawnHost(layout);
  try {
    const localFetch = createLocalEndpointFetch(endpoint.path);
    await waitForSocketHealth(localFetch, host.child, host.logs);
    const registered = await localJson(
      localFetch,
      "POST",
      "/api/v1/extension/register",
      { body: request }
    );
    assert.equal(registered.value.ok, true);
    assert.equal(registered.value.generation, 1);
    const posted = await localJson(
      localFetch,
      "POST",
      "/api/v1/extension/events",
      {
        body: {
          events: realisticNativeEvents(SESSION_ID).slice(0, 2),
          generation: registered.value.generation,
          instanceId: request.instanceId,
        },
        credential: registered.value.credential,
      }
    );
    assert.deepEqual(posted.value, {
      accepted: 2,
      duplicates: 0,
      ok: true,
    });

    // The new epoch only has sequences 1..3 (attach + two native events); the
    // client presents the stale cursor 7 from the previous epoch. The real
    // handler resyncs with a full replay from sequence 1 instead of silently
    // returning nothing (the pre-fix behavior). The production
    // `HttpHostClient` tracks its own cursor and has no epoch/reset signal, so
    // it would still drop these lower sequences; that client-side reset is
    // out of scope for E4-003 and is documented as a known limitation.
    const replayed = await collectRawSse(localFetch, SESSION_ID, 7, 3);
    assert.deepEqual(
      replayed.map((record) => record.sequence),
      [1, 2, 3]
    );
    assert.deepEqual(
      replayed.map((record) => record.type),
      [EXECUTION_EVENT_TYPE, "session_start", "agent_start"]
    );
  } finally {
    await stopChild(host.child);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});

test("the __providers stream never replays transient auth events", {
  skip: SKIP_WINDOWS,
}, async () => {
  const layout = createLayout("providers");
  // Seed the durable log with historical OAuth events, as a previous login
  // attempt would have left behind.
  const seed = new EventStore(layout.dataDir);
  seed.append("__providers", {
    event: { type: "auth_url", url: "https://example.com/oauth" },
    kind: "notify",
    providerId: "anthropic",
  });
  seed.append("__providers", {
    event: { message: "Waiting for browser", type: "progress" },
    kind: "notify",
    providerId: "anthropic",
  });
  seed.close();

  const endpoint = resolveLocalEndpoint({
    dataDir: layout.dataDir,
    platform: process.platform,
  });
  const host = spawnHost(layout);
  try {
    const localFetch = createLocalEndpointFetch(endpoint.path);
    await waitForSocketHealth(localFetch, host.child, host.logs);

    // A normal cursor still replays history, proving the stream works.
    const replayed = await collectRawSse(localFetch, "__providers", 0, 2);
    assert.deepEqual(
      replayed.map((record) => record.sequence),
      [1, 2]
    );

    // The far-future cursor the web client sends on its first subscription
    // must skip history instead of being rewound to a full replay (which
    // re-opened a stale OAuth tab merely by visiting Settings).
    const skipped = await readSseFor(
      localFetch,
      "__providers",
      Number.MAX_SAFE_INTEGER,
      800
    );
    assert.deepEqual(skipped, []);

    // A stale cursor from a wiped epoch is clamped to the tail, not rewound.
    const clamped = await readSseFor(localFetch, "__providers", 42, 800);
    assert.deepEqual(clamped, []);
  } finally {
    await stopChild(host.child);
    fs.rmSync(layout.root, { force: true, recursive: true });
  }
});
