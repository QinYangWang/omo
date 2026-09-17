import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { OpenSessionResponseSchema, parseContract } = await import(
  "../packages/contracts/dist/index.js"
);
const { EventStore } = require("../server/event-store.cjs");
const {
  appendExecutionStateEvent,
  ExecutionBroker,
} = require("../server/execution-broker.cjs");
const { ExtensionService } = require("../server/extension-service.cjs");
const { recordAttachmentLoss } = require("../server/host.cjs");
const { createNativeEventHandler } = require("../server/native-events.cjs");
const { PiService } = require("../server/pi-service.cjs");

const CWD = "/workspace";
const SESSION_PATH = "/sessions/interrupted-resume.jsonl";
const INTERRUPTED_CODE = "native_turn_interrupted";
const EXECUTION_EVENT_TYPE = "omo_execution_state";

function registerRequest(sessionId) {
  return {
    capabilities: ["commands", "events"],
    channelVersion: 1,
    extensionVersion: "0.1.0-test",
    instanceId: crypto.randomUUID(),
    piVersion: "0.85.0-test",
    sessionId,
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
 * Mock runtime adapter. `prompt` emits a fresh `turn_start` through the same
 * subscribe channel a real headless Session uses, so a resumed headless turn
 * is observable exactly like the native one it replaced.
 */
function createMockRuntime() {
  const state = {
    openSessionCalls: [],
    releases: 0,
  };
  const adapter = {
    getModelRuntime: () =>
      Promise.resolve({
        getModel: () => ({
          id: "test-model",
          name: "Test Model",
          provider: "test",
        }),
      }),
    openSession(input) {
      const listeners = new Set();
      const session = {
        abort: () => Promise.resolve(),
        dispose: () => {
          listeners.clear();
        },
        getContextUsage: () => ({ contextWindow: 100, percent: 0, tokens: 0 }),
        isIdle: true,
        isStreaming: false,
        model: { id: "test-model", name: "Test Model", provider: "test" },
        prompt() {
          session.isStreaming = true;
          for (const listener of [...listeners]) {
            listener({ turnIndex: 0, type: "turn_start" });
          }
          return Promise.resolve();
        },
        sessionFile: input.sessionPath ?? "/sessions/mock.jsonl",
        sessionId: input.sessionPath ? "durable-session" : "draft-session",
        setModel: () => Promise.resolve(),
        setThinkingLevel: () => undefined,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        thinkingLevel: "medium",
      };
      const lease = {
        release: () => {
          state.releases += 1;
          session.dispose();
        },
        session,
      };
      state.openSessionCalls.push(input);
      return lease;
    },
    openSessionDocument: () => ({
      getBranch: () => [],
      getSessionId: () => "durable-session",
    }),
  };
  return { adapter, state };
}

/**
 * In-process harness that mirrors the Host wiring for attachment loss and the
 * headless claim. `onDetach` uses the exact `recordAttachmentLoss` helper the
 * Host installs, so heartbeat expiry and explicit detach follow one code path.
 */
function createHarness(options = {}) {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "omo-interrupted-resume-")
  );
  const events = new EventStore(dataDir);
  const workspace = { resolveExisting: async (value) => value };
  const { adapter, state } = createMockRuntime();
  const service = new PiService(events, workspace, workspace, adapter);
  const clock = { value: Date.now() };
  const nativeHandler = createNativeEventHandler({ events });
  const recordExecutionState = (sessionId) =>
    appendExecutionStateEvent(events, broker, sessionId);
  const extensionService = new ExtensionService({
    canAttach: (sessionId) => broker.canAttach(sessionId),
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60_000,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 120_000,
    hostId: crypto.randomUUID(),
    now: options.injectClock ? () => clock.value : Date.now,
    onAttach: (sessionId) => recordExecutionState(sessionId),
    onAttachConfirm: (sessionId) => broker.onAttachConfirm(sessionId),
    onDetach: (sessionId) =>
      recordAttachmentLoss({ events, executionBroker: broker, sessionId }),
    onNativeEvent: (attachment, event) =>
      nativeHandler.handle(attachment, event),
    sweepIntervalMs: options.sweepIntervalMs ?? 100_000,
  });
  const broker = new ExecutionBroker({
    extensionService,
    hasHeadlessRuntime: (sessionId) => service.hasRuntime(sessionId),
    isHeadlessStreaming: (sessionId) => service.isRuntimeStreaming(sessionId),
    onHeadlessClaim: (sessionId) => recordExecutionState(sessionId),
    releaseIdleRuntime: (sessionId) => service.releaseIdleRuntime(sessionId),
  });
  service.setExecutionBroker(broker);
  return {
    broker,
    clock,
    dispose() {
      extensionService.dispose();
      service.dispose();
      events.close();
      fs.rmSync(dataDir, { force: true, recursive: true });
    },
    events,
    extensionService,
    service,
    state,
  };
}

async function register(h, sessionId) {
  const request = registerRequest(sessionId);
  const registered = await h.extensionService.register(request);
  assert.equal(registered.ok, true);
  return { registered, request };
}

function identity(registered, request) {
  return {
    generation: registered.generation,
    instanceId: request.instanceId,
  };
}

/** Models the live private command stream of the current attachment. */
function attachSubscriber(h, sessionId) {
  const attachment = h.extensionService.currentBySession.get(sessionId);
  assert.ok(attachment, `expected a live attachment for ${sessionId}`);
  const commands = [];
  attachment.subscriber = {
    close: () => undefined,
    isClosed: () => false,
    write: (command) => {
      commands.push(command);
      return true;
    },
  };
  return commands;
}

async function postNativeEvents(h, registered, request, events) {
  const result = await h.extensionService.events(
    {
      events,
      generation: registered.generation,
      instanceId: request.instanceId,
    },
    registered.credential
  );
  assert.deepEqual(result, {
    accepted: events.length,
    duplicates: 0,
    ok: true,
  });
}

function records(h, sessionId) {
  return h.events.list(sessionId);
}

function interruptedMarkers(h, sessionId) {
  return records(h, sessionId).filter(
    (record) =>
      record.type === "omo_error" && record.payload.code === INTERRUPTED_CODE
  );
}

function executionStates(h, sessionId) {
  return records(h, sessionId)
    .filter((record) => record.type === EXECUTION_EVENT_TYPE)
    .map((record) => record.payload.state);
}

test("mid-turn attachment loss marks exactly one interrupted turn and never re-dispatches", async () => {
  const h = createHarness();
  const received = [];
  let unsubscribe;
  try {
    // Subscribe before the attach so the live SSE stream covers the whole
    // crash-mid-turn sequence.
    unsubscribe = h.events.subscribe("s1", (record) => received.push(record));
    const { registered, request } = await register(h, "s1");
    const commands = attachSubscriber(h, "s1");

    // One prompt reaches the native owner before the crash.
    await h.service.prompt({
      cwd: CWD,
      message: "long running native turn",
      requestId: "native-1",
      sessionId: "s1",
    });
    assert.equal(commands.length, 1);

    // The native turn starts, then the Extension disappears mid-turn.
    await postNativeEvents(h, registered, request, [
      nativeEvent(1, "s1", {
        event: "turn_start",
        payload: { turnIndex: 0 },
      }),
    ]);
    const dispatchedBeforeLoss = commands.length;
    await h.extensionService.detach(
      identity(registered, request),
      registered.credential
    );

    // The broker must not send anything for the lost attachment.
    assert.equal(commands.length, dispatchedBeforeLoss);
    const late = h.broker.dispatchNativeCommand("s1", {
      requestId: "late",
      text: "late retry",
      type: "prompt",
    });
    assert.equal(late.delivered, false);
    assert.equal(commands.length, dispatchedBeforeLoss);

    // Live SSE delivery order is the durable order: ownership, the lost
    // turn, the single interrupted marker, then the detached transition.
    assert.deepEqual(
      received.map((record) => record.type),
      ["omo_execution_state", "turn_start", "omo_error", "omo_execution_state"]
    );
    assert.deepEqual(
      received.map((record) => record.sequence),
      [1, 2, 3, 4]
    );

    const stream = records(h, "s1");
    assert.deepEqual(
      stream.map((record) => record.type),
      ["omo_execution_state", "turn_start", "omo_error", "omo_execution_state"]
    );
    assert.deepEqual(stream[0].payload, {
      generation: registered.generation,
      ownerInstanceId: request.instanceId,
      state: "native-attached",
      type: EXECUTION_EVENT_TYPE,
    });

    const markers = interruptedMarkers(h, "s1");
    assert.equal(markers.length, 1);
    assert.deepEqual(markers[0].payload, {
      code: INTERRUPTED_CODE,
      message: markers[0].payload.message,
      retryable: true,
      type: "omo_error",
    });
    assert.equal(typeof markers[0].payload.message, "string");
    assert.ok(markers[0].payload.message.length > 0);

    // The unknown outcome is never faked into a completion.
    for (const fabricated of ["turn_end", "message_end", "agent_end"]) {
      assert.equal(
        stream.some((record) => record.type === fabricated),
        false,
        `must not fabricate ${fabricated}`
      );
    }
    assert.equal(stream.at(-1).payload.state, "detached");
    assert.equal(h.broker.executionState("s1").state, "detached");
    assert.equal(
      h.state.openSessionCalls.length,
      0,
      "an interrupted native turn must not spawn a headless runtime"
    );
  } finally {
    unsubscribe?.();
    await h.dispose();
  }
});

test("a clean detach (completed turn or no turn) emits no interrupted marker", async () => {
  const h = createHarness();
  try {
    const { registered, request } = await register(h, "s1");
    await postNativeEvents(h, registered, request, [
      nativeEvent(1, "s1", { event: "turn_start", payload: {} }),
      nativeEvent(2, "s1", { event: "turn_end", payload: {} }),
    ]);
    await h.extensionService.detach(
      identity(registered, request),
      registered.credential
    );
    assert.equal(interruptedMarkers(h, "s1").length, 0);
    assert.deepEqual(executionStates(h, "s1"), ["native-attached", "detached"]);

    const second = await register(h, "s2");
    await h.extensionService.detach(
      identity(second.registered, second.request),
      second.registered.credential
    );
    assert.equal(interruptedMarkers(h, "s2").length, 0);
    assert.deepEqual(executionStates(h, "s2"), ["native-attached", "detached"]);
  } finally {
    await h.dispose();
  }
});

test("heartbeat-timeout expiry mid-turn emits the same single interrupted marker", async () => {
  const h = createHarness({
    heartbeatTimeoutMs: 100,
    injectClock: true,
    sweepIntervalMs: 100_000,
  });
  try {
    const { registered, request } = await register(h, "s1");
    await postNativeEvents(h, registered, request, [
      nativeEvent(1, "s1", { event: "turn_start", payload: {} }),
    ]);
    assert.equal(h.broker.executionState("s1").state, "native-attached");

    h.clock.value += 1000;
    h.extensionService.sweepExpired();
    // A repeated sweep must not append a second marker or transition.
    h.extensionService.sweepExpired();

    const markers = interruptedMarkers(h, "s1");
    assert.equal(markers.length, 1);
    assert.equal(markers[0].payload.retryable, true);
    assert.deepEqual(executionStates(h, "s1"), ["native-attached", "detached"]);
    assert.equal(h.broker.executionState("s1").state, "detached");
  } finally {
    await h.dispose();
  }
});

test("a detached Session becomes headless-owned through exactly one explicit claim", async () => {
  const h = createHarness();
  try {
    const { registered, request } = await register(h, "s1");
    await h.extensionService.detach(
      identity(registered, request),
      registered.credential
    );

    const received = [];
    const unsubscribe = h.events.subscribe("s1", (record) =>
      received.push(record)
    );
    let first;
    let second;
    try {
      first = await h.service.open({
        cwd: CWD,
        sessionId: "s1",
        sessionPath: SESSION_PATH,
      });
      assert.deepEqual(first.execution, { state: "headless-owned" });
      second = await h.service.open({
        cwd: CWD,
        sessionId: "s1",
        sessionPath: SESSION_PATH,
      });
      assert.deepEqual(second.execution, { state: "headless-owned" });
    } finally {
      unsubscribe();
    }

    const claims = received.filter(
      (record) =>
        record.type === EXECUTION_EVENT_TYPE &&
        record.payload.state === "headless-owned"
    );
    assert.equal(claims.length, 1);
    assert.deepEqual(claims[0].payload, {
      state: "headless-owned",
      type: EXECUTION_EVENT_TYPE,
    });
    assert.equal(
      h.state.openSessionCalls.length,
      1,
      "the second open must reuse the claimed runtime"
    );
  } finally {
    await h.dispose();
  }
});

test("the prompt claim path emits the same single headless-owned transition", async () => {
  const h = createHarness();
  try {
    const received = [];
    const unsubscribe = h.events.subscribe("s1", (record) =>
      received.push(record)
    );
    const accepted = await h.service.prompt({
      cwd: CWD,
      message: "resume headless",
      requestId: "headless-1",
      sessionId: "s1",
    });
    unsubscribe();
    assert.equal(accepted.operationId, "headless-1");
    const claims = received.filter(
      (record) => record.type === EXECUTION_EVENT_TYPE
    );
    assert.equal(claims.length, 1);
    assert.equal(claims[0].payload.state, "headless-owned");

    // A second prompt reuses the runtime, so no second claim is written.
    const receivedAgain = [];
    const unsubscribeAgain = h.events.subscribe("s1", (record) =>
      receivedAgain.push(record)
    );
    await h.service.prompt({
      cwd: CWD,
      message: "again",
      requestId: "headless-2",
      sessionId: "s1",
    });
    unsubscribeAgain();
    assert.equal(
      receivedAgain.filter((record) => record.type === EXECUTION_EVENT_TYPE)
        .length,
      0
    );
    assert.equal(h.state.openSessionCalls.length, 1);
  } finally {
    await h.dispose();
  }
});

test("an interrupted Session resumes headless without retrying the lost turn", async () => {
  const h = createHarness();
  try {
    const { registered, request } = await register(h, "s1");
    const commands = attachSubscriber(h, "s1");
    await h.service.prompt({
      cwd: CWD,
      message: "native prompt",
      requestId: "native-1",
      sessionId: "s1",
    });
    await postNativeEvents(h, registered, request, [
      nativeEvent(1, "s1", { event: "turn_start", payload: {} }),
    ]);
    await h.extensionService.detach(
      identity(registered, request),
      registered.credential
    );
    const dispatchedBeforeResume = commands.length;

    const accepted = await h.service.prompt({
      cwd: CWD,
      message: "resume headless",
      requestId: "headless-1",
      sessionId: "s1",
    });
    assert.equal(accepted.operationId, "headless-1");

    // No command was re-dispatched to the lost attachment.
    assert.equal(commands.length, dispatchedBeforeResume);
    // The resumed headless turn has its own fresh turn_start alongside the
    // interrupted native one, and still no fabricated completion.
    const turnStarts = records(h, "s1").filter(
      (record) => record.type === "turn_start"
    );
    assert.equal(turnStarts.length, 2);
    assert.equal(interruptedMarkers(h, "s1").length, 1);
    assert.equal(
      records(h, "s1").some((record) => record.type === "turn_end"),
      false
    );
    assert.equal(h.state.openSessionCalls.length, 1);
    assert.equal(h.broker.executionState("s1").state, "headless-owned");
  } finally {
    await h.dispose();
  }
});

test("open() without a sessionId mints one instead of crashing", async () => {
  const h = createHarness();
  try {
    const opened = await h.service.open({ cwd: CWD });
    assert.equal(typeof opened.sessionId, "string");
    assert.ok(opened.sessionId.length > 0);
    assert.equal(typeof opened.eventSequence, "number");
    assert.deepEqual(opened.execution, { state: "headless-owned" });
    const validated = parseContract(
      OpenSessionResponseSchema,
      opened,
      "OpenSessionResponse"
    );
    assert.equal(validated.sessionId, opened.sessionId);
    assert.equal(h.state.openSessionCalls.length, 1);
  } finally {
    await h.dispose();
  }
});

test("every interrupted marker carries the documented omo_error payload shape", async () => {
  // The frozen contracts do not export a named `OmoErrorPayloadSchema`; this
  // asserts the exact shape the contract requires (`type`, `code`, `message`,
  // `retryable`, extras allowed) for every appended interrupted marker.
  const h = createHarness();
  try {
    const { registered, request } = await register(h, "s1");
    await postNativeEvents(h, registered, request, [
      nativeEvent(1, "s1", { event: "turn_start", payload: {} }),
    ]);
    await h.extensionService.detach(
      identity(registered, request),
      registered.credential
    );

    const markers = interruptedMarkers(h, "s1");
    assert.equal(markers.length, 1);
    for (const record of markers) {
      const { payload } = record;
      assert.equal(payload.type, "omo_error");
      assert.equal(typeof payload.code, "string");
      assert.ok(payload.code.length > 0);
      assert.equal(typeof payload.message, "string");
      assert.ok(payload.message.length > 0);
      assert.equal(typeof payload.retryable, "boolean");
      assert.equal(payload.retryable, true);
    }
  } finally {
    await h.dispose();
  }
});
