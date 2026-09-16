import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { EventStore } = require("../server/event-store.cjs");
const { ExecutionBroker } = require("../server/execution-broker.cjs");
const { ExtensionService } = require("../server/extension-service.cjs");
const { createNativeEventHandler } = require("../server/native-events.cjs");
const { PiService } = require("../server/pi-service.cjs");

const SESSION_ID = "session-native-1";
// The file watcher debounces for 250ms; wait comfortably past it.
const WATCHER_SETTLE_MS = 700;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * Mock runtime adapter mirroring the headless Session shape PiService needs.
 * Its durable `sessionId` equals the requested one so a single Session maps to
 * a single event stream (no draft/durable aliasing).
 */
function createMockRuntime(sessionId) {
  const state = {
    openSessionCalls: [],
    sessions: new Map(),
  };
  const adapter = {
    getModelRuntime: () =>
      Promise.resolve({
        getModel: () => ({ id: "test-model", name: "Test", provider: "test" }),
      }),
    openSession(input) {
      const listeners = new Set();
      const session = {
        emit(event) {
          for (const listener of [...listeners]) {
            listener(event);
          }
        },
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
      const lease = {
        release: () => {
          listeners.clear();
          session.dispose?.();
        },
        session,
      };
      state.openSessionCalls.push(input);
      state.sessions.set(sessionId, session);
      return lease;
    },
    openSessionDocument: () => ({
      getBranch: () => [],
      getSessionId: () => sessionId,
    }),
  };
  return { adapter, state };
}

/**
 * In-process wiring that mirrors `initializeHost`: real EventStore, real
 * ExtensionService, real PiService with a mocked runtime, a real
 * ExecutionBroker, the late-bound native handler and a real loopback HTTP
 * server that serves `ExtensionService.handle`.
 */
async function createHarness(options = {}) {
  const sessionId = options.sessionId ?? SESSION_ID;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-native-events-"));
  const events = new EventStore(dataDir);
  const workspace = { resolveExisting: async (value) => value };
  const { adapter, state } = createMockRuntime(sessionId);
  const service = new PiService(events, workspace, workspace, adapter);
  let nativeEventHandler;
  let broker;
  const extensionService = new ExtensionService({
    canAttach: (id) => broker.canAttach(id),
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 1000,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 60_000,
    hostId: crypto.randomUUID(),
    onAttachConfirm: (id) => broker.onAttachConfirm(id),
    onNativeEvent: (attachment, event) =>
      nativeEventHandler.handle(attachment, event),
    sweepIntervalMs: options.sweepIntervalMs ?? 1000,
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

function sessionFileEvents(events, sessionId) {
  return events
    .list(sessionId)
    .filter((record) => record.type === "omo_session_file");
}

test("maps fresh native events onto the host event stream in native order", async () => {
  const h = await createHarness();
  try {
    const request = registerRequest(SESSION_ID);
    const registered = await h.extensionService.register(request);
    assert.equal(registered.ok, true);

    const received = [];
    const unsubscribe = h.events.subscribe(SESSION_ID, (record) =>
      received.push(record)
    );
    const before = h.events.latestSequence(SESSION_ID);
    assert.equal(before, 0);

    const result = await postEvents(h, {
      credential: registered.credential,
      events: [
        nativeEvent(1, SESSION_ID, {
          event: "message_update",
          payload: {
            assistantMessageEvent: { delta: "hello", type: "text_delta" },
            type: "message_update",
          },
        }),
        // A conflicting `type` in the payload must not win over the Pi name.
        nativeEvent(2, SESSION_ID, {
          event: "turn_start",
          payload: { turnIndex: 0, type: "conflicting" },
        }),
      ],
      generation: registered.generation,
      instanceId: request.instanceId,
    });
    unsubscribe();

    assert.deepEqual(result.value, { accepted: 2, duplicates: 0, ok: true });
    const records = h.events.list(SESSION_ID, before);
    assert.deepEqual(
      records.map((record) => record.sequence),
      [1, 2]
    );
    assert.equal(records[0].type, "message_update");
    assert.equal(records[0].payload.type, "message_update");
    assert.equal(records[0].payload.assistantMessageEvent.delta, "hello");
    assert.equal(records[1].type, "turn_start");
    assert.equal(records[1].payload.turnIndex, 0);

    // SSE subscribers (the `/api/v1/events` stream) observe the same order.
    assert.deepEqual(
      received.map((record) => [record.sequence, record.type]),
      [
        [1, "message_update"],
        [2, "turn_start"],
      ]
    );
  } finally {
    await h.close();
  }
});

test("re-posting a batch is deduplicated before the mapper runs", async () => {
  const h = await createHarness();
  try {
    const request = registerRequest(SESSION_ID);
    const registered = await h.extensionService.register(request);
    const batch = {
      credential: registered.credential,
      events: [
        nativeEvent(1, SESSION_ID),
        nativeEvent(2, SESSION_ID),
        nativeEvent(3, SESSION_ID),
      ],
      generation: registered.generation,
      instanceId: request.instanceId,
    };

    const first = await postEvents(h, batch);
    assert.deepEqual(first.value, { accepted: 3, duplicates: 0, ok: true });
    const sequenceAfterFirst = h.events.latestSequence(SESSION_ID);
    assert.equal(sequenceAfterFirst, 3);
    assert.equal(h.nativeEventHandler.stats.mapped, 3);

    const second = await postEvents(h, batch);
    assert.deepEqual(second.value, { accepted: 0, duplicates: 3, ok: true });
    assert.equal(h.events.latestSequence(SESSION_ID), sequenceAfterFirst);
    // The mapper only ever saw the three fresh events.
    assert.equal(h.nativeEventHandler.stats.mapped, 3);
  } finally {
    await h.close();
  }
});

test("fences events that do not belong to the owning attachment", async () => {
  const h = await createHarness();
  try {
    const request = registerRequest(SESSION_ID);
    const registered = await h.extensionService.register(request);

    // Direct mapper call: a foreign Session can never be written.
    const fenced = h.nativeEventHandler.handle(
      { sessionId: SESSION_ID },
      nativeEvent(1, "other-session")
    );
    assert.equal(fenced, null);
    assert.equal(h.nativeEventHandler.stats.dropped, 1);
    assert.equal(h.events.latestSequence("other-session"), 0);
    assert.equal(h.events.latestSequence(SESSION_ID), 0);

    // Malformed events are counted, not thrown.
    assert.equal(
      h.nativeEventHandler.handle({ sessionId: SESSION_ID }, undefined),
      null
    );
    assert.equal(
      h.nativeEventHandler.handle(
        { sessionId: SESSION_ID },
        nativeEvent(1, SESSION_ID, { event: "" })
      ),
      null
    );
    assert.equal(h.nativeEventHandler.stats.dropped, 3);

    // Through the real channel the batch is rejected before any append.
    const rejected = await postEvents(h, {
      credential: registered.credential,
      events: [nativeEvent(1, "other-session")],
      generation: registered.generation,
      instanceId: request.instanceId,
    });
    assert.equal(rejected.status, 400);
    assert.equal(h.events.latestSequence(SESSION_ID), 0);
    assert.equal(h.events.latestSequence("other-session"), 0);
  } finally {
    await h.close();
  }
});

test("headless and native events share one contiguous host sequence", async () => {
  const h = await createHarness();
  try {
    // Headless events first, through the PiService subscribe path.
    await h.service.ensure(SESSION_ID, "/workspace");
    const session = h.state.sessions.get(SESSION_ID);
    session.emit({ message: { role: "assistant" }, type: "message_start" });
    session.emit({
      assistantMessageEvent: { delta: "a", type: "text_delta" },
      type: "message_update",
    });
    assert.deepEqual(
      h.events.list(SESSION_ID).map((record) => record.sequence),
      [1, 2]
    );

    // Attach at an idle boundary: the headless runtime is released.
    const request = registerRequest(SESSION_ID);
    const registered = await h.extensionService.register(request);
    assert.equal(registered.ok, true);
    assert.equal(h.broker.executionState(SESSION_ID).state, "native-attached");
    assert.equal(h.service.hasRuntime(SESSION_ID), false);

    // Native events continue the same stream.
    const result = await postEvents(h, {
      credential: registered.credential,
      events: [
        nativeEvent(1, SESSION_ID, {
          event: "turn_start",
          payload: { turnIndex: 1 },
        }),
        nativeEvent(2, SESSION_ID, {
          event: "message_update",
          payload: {
            assistantMessageEvent: { delta: "b", type: "text_delta" },
            type: "message_update",
          },
        }),
      ],
      generation: registered.generation,
      instanceId: request.instanceId,
    });
    assert.deepEqual(result.value, { accepted: 2, duplicates: 0, ok: true });

    const all = h.events.list(SESSION_ID);
    assert.deepEqual(
      all.map((record) => record.sequence),
      [1, 2, 3, 4]
    );
    assert.deepEqual(
      all.map((record) => record.type),
      ["message_start", "message_update", "turn_start", "message_update"]
    );
    assert.equal(h.events.latestTurnStartSequence(SESSION_ID), 3);
  } finally {
    await h.close();
  }
});

test("suppresses the file watcher while native-attached and resumes after detach", async () => {
  const h = await createHarness();
  const filePath = path.join(h.dataDir, "session.jsonl");
  try {
    fs.writeFileSync(filePath, "line-1\n");
    h.service.watchSessionFile(SESSION_ID, filePath);
    await delay(50);

    // (a) Not attached: one real change emits exactly one event.
    fs.appendFileSync(filePath, "line-2\n");
    await delay(WATCHER_SETTLE_MS);
    assert.equal(sessionFileEvents(h.events, SESSION_ID).length, 1);

    // (b) Native-attached: the watcher stays armed but emits nothing.
    const request = registerRequest(SESSION_ID);
    const registered = await h.extensionService.register(request);
    assert.equal(registered.ok, true);
    assert.equal(h.service.nativeAttached(SESSION_ID), true);
    fs.appendFileSync(filePath, "line-3\n");
    await delay(WATCHER_SETTLE_MS);
    assert.equal(sessionFileEvents(h.events, SESSION_ID).length, 1);

    // (c) After detach the next real change emits exactly one event again.
    await h.extensionService.detach(
      { generation: registered.generation, instanceId: request.instanceId },
      registered.credential
    );
    assert.equal(h.service.nativeAttached(SESSION_ID), false);
    fs.appendFileSync(filePath, "line-4\n");
    await delay(WATCHER_SETTLE_MS);
    assert.equal(sessionFileEvents(h.events, SESSION_ID).length, 2);
  } finally {
    await h.close();
  }
});
