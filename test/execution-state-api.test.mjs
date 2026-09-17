import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  AgentEventEnvelopeSchema,
  ContractValidationError,
  OpenSessionResponseSchema,
  parseContract,
} = await import("../packages/contracts/dist/index.js");
const { EventStore } = require("../server/event-store.cjs");
const {
  appendExecutionStateEvent,
  ExecutionBroker,
} = require("../server/execution-broker.cjs");
const { ExtensionService } = require("../server/extension-service.cjs");
const { PiService } = require("../server/pi-service.cjs");

const SESSION_ID = "execution-state-session";
const SESSION_PATH = "/sessions/execution-state.jsonl";

// A leaked instance credential is 64 hex chars and never JSON; the recursive
// scan below looks for the credential-bearing key names instead.
const CREDENTIAL_KEY_PATTERN = /credential|authorization|token$/i;
const EXECUTION_EVENT_TYPE = "omo_execution_state";

function registerRequest(sessionId = SESSION_ID, overrides = {}) {
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

function createMockRuntime() {
  const state = {
    openSessionCalls: [],
    releases: 0,
    sessions: new Map(),
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
      const session = {
        dispose: () => undefined,
        getContextUsage: () => ({ contextWindow: 100, percent: 0, tokens: 0 }),
        isIdle: true,
        isStreaming: false,
        model: { id: "test-model", name: "Test Model", provider: "test" },
        prompt: () => Promise.resolve(),
        sessionFile: input.sessionPath ?? "/sessions/mock.jsonl",
        sessionId: "durable-session",
        setModel: () => Promise.resolve(),
        setThinkingLevel: () => undefined,
        subscribe: () => () => undefined,
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
      state.sessions.set(input.sessionPath ?? "draft-session", session);
      return lease;
    },
    openSessionDocument: () => ({
      getBranch: () => [],
      getSessionId: () => "durable-session",
    }),
  };
  return { adapter, state };
}

function createHarness(options = {}) {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "omo-execution-state-")
  );
  const events = new EventStore(dataDir);
  const workspace = { resolveExisting: async (value) => value };
  const { adapter, state } = createMockRuntime();
  const service = new PiService(events, workspace, workspace, adapter);
  const clock = { value: Date.now() };
  const recordExecutionState = (sessionId) =>
    appendExecutionStateEvent(events, broker, sessionId);
  const extensionService = new ExtensionService({
    canAttach: (sessionId) => broker.canAttach(sessionId),
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 200,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 400,
    hostId: crypto.randomUUID(),
    now: options.injectClock ? () => clock.value : Date.now,
    onAttach: (sessionId) => recordExecutionState(sessionId),
    onAttachConfirm: (sessionId) => broker.onAttachConfirm(sessionId),
    onDetach: (sessionId) => recordExecutionState(sessionId),
    sweepIntervalMs: options.sweepIntervalMs ?? 20,
  });
  const broker = new ExecutionBroker({
    extensionService,
    hasHeadlessRuntime: (sessionId) => service.hasRuntime(sessionId),
    isHeadlessStreaming: (sessionId) => service.isRuntimeStreaming(sessionId),
    releaseIdleRuntime: (sessionId) => service.releaseIdleRuntime(sessionId),
  });
  if (options.wireBroker !== false) {
    service.setExecutionBroker(broker);
  }
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

/** Every key that appears anywhere in a JSON-ish value. */
function collectKeys(value, keys = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return keys;
  }
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    keys.push(key);
    collectKeys(nested, keys, seen);
  }
  return keys;
}

function assertNoCredentialKeys(value, label) {
  for (const key of collectKeys(value)) {
    assert.ok(
      !CREDENTIAL_KEY_PATTERN.test(key),
      `${label} leaked credential-bearing key ${key}`
    );
  }
}

function executionEvents(records) {
  return records.filter((record) => record.type === EXECUTION_EVENT_TYPE);
}

function assertTransitionEnvelopes(records) {
  for (const record of executionEvents(records)) {
    const envelope = parseContract(
      AgentEventEnvelopeSchema,
      record,
      "AgentEventEnvelope"
    );
    assert.equal(envelope.type, EXECUTION_EVENT_TYPE);
    assert.ok(envelope.sequence >= 1);
  }
}

test("open() reports ownership and attach/detach emit one transition event each", async () => {
  const h = createHarness();
  try {
    const received = [];
    const unsubscribe = h.events.subscribe(SESSION_ID, (record) =>
      received.push(record)
    );
    let request;
    let registered;
    try {
      // 1) A fresh durable Session has no owner. This open creates the
      //    headless runtime, so its response reports the ownership it leaves
      //    behind (`headless-owned`), never the entry-time `detached` state.
      //    Headless creation is client-initiated and emits no transition.
      const first = parseContract(
        OpenSessionResponseSchema,
        await h.service.open({
          cwd: "/workspace",
          sessionId: SESSION_ID,
          sessionPath: SESSION_PATH,
        }),
        "OpenSessionResponse"
      );
      assert.deepEqual(first.execution, { state: "headless-owned" });
      assert.equal(h.broker.executionState(SESSION_ID).state, "headless-owned");
      assert.equal(h.state.openSessionCalls.length, 1);

      // Surrounding Host event for sequence-continuity checks.
      h.events.append(SESSION_ID, { type: "marker_before" });

      // 2) A later open observes the headless executor.
      const second = parseContract(
        OpenSessionResponseSchema,
        await h.service.open({
          cwd: "/workspace",
          sessionId: SESSION_ID,
          sessionPath: SESSION_PATH,
        }),
        "OpenSessionResponse"
      );
      assert.deepEqual(second.execution, { state: "headless-owned" });

      // 3) Native attach performs the idle handoff and becomes the owner.
      request = registerRequest();
      registered = await h.extensionService.register(request);
      assert.equal(registered.ok, true);
      assert.equal(
        h.broker.executionState(SESSION_ID).state,
        "native-attached"
      );
      assert.equal(h.service.hasRuntime(SESSION_ID), false);

      // An open while attached takes the sessionPath history path: it creates
      // no runtime, so it reports the broker's current ownership as of the
      // response (native-attached with generation/instance id, no credential).
      const third = parseContract(
        OpenSessionResponseSchema,
        await h.service.open({
          cwd: "/workspace",
          sessionId: SESSION_ID,
          sessionPath: SESSION_PATH,
        }),
        "OpenSessionResponse"
      );
      assert.deepEqual(third.execution, h.broker.executionState(SESSION_ID));
      assert.deepEqual(third.execution, {
        generation: registered.generation,
        ownerInstanceId: request.instanceId,
        state: "native-attached",
      });
      assert.equal(h.state.openSessionCalls.length, 1);

      // 4) Detach releases ownership back to detached; the next sessionPath
      //    open creates a fresh headless runtime, so its response reports
      //    `headless-owned` again rather than the entry-time detached state.
      await h.extensionService.detach(
        { generation: registered.generation, instanceId: request.instanceId },
        registered.credential
      );
      const fourth = parseContract(
        OpenSessionResponseSchema,
        await h.service.open({
          cwd: "/workspace",
          sessionId: SESSION_ID,
          sessionPath: SESSION_PATH,
        }),
        "OpenSessionResponse"
      );
      assert.deepEqual(fourth.execution, { state: "headless-owned" });

      h.events.append(SESSION_ID, { type: "marker_after" });
    } finally {
      unsubscribe();
    }

    // Exactly one transition per transition: attach + detach. No event for the
    // headless runtime created by open(). Assert exact counts, no duplicates.
    const transitions = executionEvents(received);
    assert.equal(transitions.length, 2);
    assert.deepEqual(transitions[0].payload, {
      generation: registered.generation,
      ownerInstanceId: request.instanceId,
      state: "native-attached",
      type: EXECUTION_EVENT_TYPE,
    });
    assert.deepEqual(transitions[1].payload, {
      state: "detached",
      type: EXECUTION_EVENT_TYPE,
    });

    // Host sequence continuity across the surrounding markers: the stream is
    // marker_before -> attach -> detach -> marker_after with no gaps or dupes.
    assert.deepEqual(
      received.map((record) => record.type),
      [
        "marker_before",
        EXECUTION_EVENT_TYPE,
        EXECUTION_EVENT_TYPE,
        "marker_after",
      ]
    );
    assert.deepEqual(
      received.map((record) => record.sequence),
      [1, 2, 3, 4]
    );
    assert.equal(transitions[1].sequence, transitions[0].sequence + 1);

    // Credential-free by construction: scan every response and event payload.
    assertNoCredentialKeys(received, "execution transition stream");
    assertTransitionEnvelopes(received);
  } finally {
    await h.dispose();
  }
});

test("heartbeat timeout emits exactly one detached transition", async () => {
  const h = createHarness({
    heartbeatTimeoutMs: 100,
    injectClock: true,
    sweepIntervalMs: 100_000,
  });
  try {
    const received = [];
    const unsubscribe = h.events.subscribe(SESSION_ID, (record) =>
      received.push(record)
    );
    try {
      const request = registerRequest();
      const registered = await h.extensionService.register(request);
      assert.equal(registered.ok, true);
      assert.equal(
        h.broker.executionState(SESSION_ID).state,
        "native-attached"
      );

      h.clock.value += 1000;
      h.extensionService.sweepExpired();
      // A repeated sweep must not append a second detached event.
      h.extensionService.sweepExpired();
    } finally {
      unsubscribe();
    }

    assert.equal(h.broker.executionState(SESSION_ID).state, "detached");
    const transitions = executionEvents(received);
    assert.equal(transitions.length, 2);
    assert.equal(transitions[0].payload.state, "native-attached");
    assert.deepEqual(transitions[1].payload, {
      state: "detached",
      type: EXECUTION_EVENT_TYPE,
    });
    assert.equal(transitions[1].sequence, transitions[0].sequence + 1);
    assertNoCredentialKeys(received, "heartbeat-timeout transition stream");
    assertTransitionEnvelopes(received);
  } finally {
    await h.dispose();
  }
});

test("open() without sessionPath also carries the execution view", async () => {
  const h = createHarness();
  try {
    const opened = parseContract(
      OpenSessionResponseSchema,
      await h.service.open({ cwd: "/workspace", sessionId: SESSION_ID }),
      "OpenSessionResponse"
    );
    // The first open creates the headless runtime, so the response reports
    // the ownership it leaves behind, not the entry-time detached state.
    assert.deepEqual(opened.execution, { state: "headless-owned" });
    const reopened = parseContract(
      OpenSessionResponseSchema,
      await h.service.open({ cwd: "/workspace", sessionId: SESSION_ID }),
      "OpenSessionResponse"
    );
    assert.deepEqual(reopened.execution, { state: "headless-owned" });
    assertNoCredentialKeys(opened, "open without sessionPath");
  } finally {
    await h.dispose();
  }
});

test("a Session with no broker wiring keeps working with a sensible default", async () => {
  const h = createHarness({ wireBroker: false });
  try {
    const opened = parseContract(
      OpenSessionResponseSchema,
      await h.service.open({ cwd: "/workspace", sessionId: SESSION_ID }),
      "OpenSessionResponse"
    );
    assert.deepEqual(opened.execution, { state: "headless-owned" });
    assertNoCredentialKeys(opened, "brokerless open");
  } finally {
    await h.dispose();
  }
});

test("rejected attaches and daemon restart emit no phantom transitions", async () => {
  const h = createHarness();
  try {
    // A streaming headless runtime rejects the attach; no generation is minted
    // and no transition event is written for the never-attached generation.
    await h.service.open({ cwd: "/workspace", sessionId: SESSION_ID });
    h.state.sessions.get("draft-session").isStreaming = true;
    const rejected = await h.extensionService.register(registerRequest());
    assert.deepEqual(rejected, { ok: false, reason: "headless_streaming" });
    assert.equal(
      executionEvents(h.events.list(SESSION_ID)).length,
      0,
      "rejected attach must not append a transition"
    );

    // Disposing the daemon clears the registry without releasing attachments;
    // restart must not fabricate a detached transition for a generation that
    // never attached.
    h.extensionService.dispose();
    assert.equal(executionEvents(h.events.list(SESSION_ID)).length, 0);
  } finally {
    await h.dispose();
  }
});

test("SessionExecutionState contract stays a closed, credential-free view", async () => {
  const { SessionExecutionStateSchema } = await import(
    "../packages/contracts/dist/index.js"
  );
  for (const state of ["headless-owned", "native-attached", "detached"]) {
    assert.equal(
      parseContract(SessionExecutionStateSchema, { state }, "state").state,
      state
    );
  }
  assert.throws(
    () =>
      parseContract(
        SessionExecutionStateSchema,
        { state: "connecting" },
        "state"
      ),
    ContractValidationError
  );
});
