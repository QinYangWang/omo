import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { EventStore } = require("../server/event-store.cjs");
const { ExecutionBroker } = require("../server/execution-broker.cjs");
const { ExtensionService } = require("../server/extension-service.cjs");
const { PiService } = require("../server/pi-service.cjs");

const tick = () => new Promise((resolve) => setImmediate(resolve));

const NATIVE_ATTACHED_PATTERN = /session_native_attached/;

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

/**
 * Mock runtime adapter with a controllable `isStreaming`, spyable
 * `openSession` count and observable `subscribe`/`dispose`/lease release.
 */
function createMockRuntime(runtimeOptions = {}) {
  const state = {
    aborts: 0,
    disposals: 0,
    listeners: new Set(),
    openSessionCalls: [],
    prompts: [],
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
      const listeners = new Set();
      const session = {
        abort() {
          state.aborts += 1;
          return Promise.resolve();
        },
        dispose() {
          state.disposals += 1;
          listeners.clear();
          state.listeners.clear();
        },
        emit(event) {
          for (const listener of [...listeners]) {
            listener(event);
          }
        },
        getContextUsage: () => ({ contextWindow: 100, percent: 0, tokens: 0 }),
        isIdle: true,
        isStreaming: false,
        model: { id: "test-model", name: "Test Model", provider: "test" },
        prompt(message, options) {
          state.prompts.push({ message, options });
          if (typeof runtimeOptions.prompt === "function") {
            return runtimeOptions.prompt(message, options, session);
          }
          session.isStreaming = true;
          return Promise.resolve();
        },
        sessionFile: input.sessionPath ?? "/sessions/mock.jsonl",
        sessionId: input.sessionPath ? "durable-session" : "draft-session",
        setModel: () => Promise.resolve(),
        setThinkingLevel: () => undefined,
        subscribe(listener) {
          listeners.add(listener);
          state.listeners.add(listener);
          return () => {
            listeners.delete(listener);
            state.listeners.delete(listener);
          };
        },
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
    path.join(os.tmpdir(), "omo-execution-broker-")
  );
  const events = new EventStore(dataDir);
  const workspace = { resolveExisting: async (value) => value };
  const { adapter, state } = createMockRuntime({ prompt: options.prompt });
  const service = new PiService(
    events,
    workspace,
    workspace,
    adapter,
    options.operationLedger
  );
  const clock = { value: Date.now() };
  const extensionService = new ExtensionService({
    canAttach: (sessionId) => broker.canAttach(sessionId),
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 200,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 400,
    hostId: crypto.randomUUID(),
    now: options.injectClock ? () => clock.value : Date.now,
    onAttachConfirm: (sessionId) => broker.onAttachConfirm(sessionId),
    sweepIntervalMs: options.sweepIntervalMs ?? 20,
  });
  const broker = new ExecutionBroker({
    extensionService,
    hasHeadlessRuntime: (sessionId) => service.hasRuntime(sessionId),
    isHeadlessStreaming: (sessionId) => service.isRuntimeStreaming(sessionId),
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

test("broker projects detached -> headless-owned -> native-attached -> detached", async () => {
  const h = createHarness();
  try {
    assert.deepEqual(h.broker.executionState("s"), { state: "detached" });

    await h.service.open({ cwd: "/workspace", sessionId: "s" });
    assert.equal(h.broker.executionState("s").state, "headless-owned");
    assert.equal(h.state.openSessionCalls.length, 1);

    const request = registerRequest("s");
    const registered = await h.extensionService.register(request);
    assert.equal(registered.ok, true);
    assert.equal(h.broker.executionState("s").state, "native-attached");
    assert.equal(
      h.broker.executionState("s").ownerInstanceId,
      request.instanceId
    );
    // The idle headless runtime is gone before the attachment is confirmed.
    assert.equal(h.service.hasRuntime("s"), false);
    assert.equal(h.service.hasRuntime("draft-session"), false);

    await h.extensionService.detach(
      { generation: registered.generation, instanceId: request.instanceId },
      registered.credential
    );
    assert.equal(h.broker.executionState("s").state, "detached");

    // No automatic headless creation on detach; the next explicit action may
    // create exactly one runtime.
    assert.equal(h.state.openSessionCalls.length, 1);
    await h.service.prompt({
      cwd: "/workspace",
      message: "again",
      requestId: "r1",
      sessionId: "s",
    });
    assert.equal(h.broker.executionState("s").state, "headless-owned");
    assert.equal(h.state.openSessionCalls.length, 2);
  } finally {
    await h.dispose();
  }
});

test("a live attachment blocks a competing register with the broker wired", async () => {
  const h = createHarness();
  try {
    const first = registerRequest("s");
    const registered = await h.extensionService.register(first);
    assert.equal(registered.ok, true);

    const competitor = registerRequest("s");
    const rejected = await h.extensionService.register(competitor);
    assert.deepEqual(rejected, {
      ok: false,
      reason: "session_already_attached",
    });
    assert.equal(
      h.broker.executionState("s").ownerInstanceId,
      first.instanceId
    );
  } finally {
    await h.dispose();
  }
});

test("a streaming headless runtime rejects attach without disturbance", async () => {
  const h = createHarness();
  try {
    await h.service.open({ cwd: "/workspace", sessionId: "s" });
    const session = h.state.sessions.get("draft-session");
    session.isStreaming = true;

    const rejected = await h.extensionService.register(registerRequest("s"));
    assert.deepEqual(rejected, { ok: false, reason: "headless_streaming" });
    // No generation was minted for the rejected attach.
    assert.equal(h.extensionService.generations.get("s"), undefined);
    assert.equal(h.extensionService.executionState("s").state, "detached");
    // The running runtime was not released or disposed.
    assert.equal(h.state.releases, 0);
    assert.equal(h.state.disposals, 0);
    assert.equal(h.service.hasRuntime("s"), true);
    assert.equal(h.service.isRuntimeStreaming("s"), true);

    await h.service.prompt({
      cwd: "/workspace",
      message: "follow up",
      requestId: "r1",
      sessionId: "s",
    });
    assert.equal(h.state.prompts.length, 1);
    assert.equal(h.state.openSessionCalls.length, 1);
  } finally {
    await h.dispose();
  }
});

test("a native-attached session refuses headless ownership and operations", async () => {
  const h = createHarness();
  try {
    const request = registerRequest("s");
    const registered = await h.extensionService.register(request);
    assert.equal(registered.ok, true);

    // open() serves history from the Session file without opening a runtime.
    const opened = await h.service.open({
      cwd: "/workspace",
      sessionId: "s",
      sessionPath: "/sessions/durable.jsonl",
    });
    assert.equal(opened.isStreaming, false);
    assert.equal(opened.model, null);
    assert.equal(opened.contextUsage, null);
    assert.equal(opened.sessionId, "durable-session");
    assert.equal(h.state.openSessionCalls.length, 0);

    const isNativeAttached = (error) =>
      error.message === "session_native_attached";
    await assert.rejects(
      h.service.prompt({
        cwd: "/workspace",
        message: "hi",
        requestId: "r1",
        sessionId: "s",
      }),
      isNativeAttached
    );
    await assert.rejects(h.service.abort("s"), isNativeAttached);
    await assert.rejects(
      h.service.setModel("s", "test", "test-model"),
      isNativeAttached
    );
    await assert.rejects(h.service.setThinking("s", "low"), isNativeAttached);
    await assert.rejects(h.service.branch("s", "entry-1"), isNativeAttached);
    await assert.rejects(
      h.service.commands({ cwd: "/workspace", sessionId: "s" }),
      isNativeAttached
    );
    await assert.rejects(
      h.service.contextUsage({ cwd: "/workspace", sessionId: "s" }),
      isNativeAttached
    );
    await assert.rejects(
      h.service.contextDetails({ cwd: "/workspace", sessionId: "s" }),
      isNativeAttached
    );
    assert.equal(h.state.openSessionCalls.length, 0);
  } finally {
    await h.dispose();
  }
});

test("idle handoff unsubscribes the headless runtime and disposes it", async () => {
  const h = createHarness();
  try {
    await h.service.open({ cwd: "/workspace", sessionId: "s" });
    const session = h.state.sessions.get("draft-session");
    assert.equal(h.state.listeners.size, 1);

    const registered = await h.extensionService.register(registerRequest("s"));
    assert.equal(registered.ok, true);
    // Unsubscribed synchronously, released/disposed through the adapter lease.
    assert.equal(h.state.listeners.size, 0);
    assert.equal(h.state.releases, 1);
    assert.equal(h.state.disposals, 1);
    assert.equal(h.service.hasRuntime("s"), false);

    const before = h.events.latestSequence("s");
    session.emit({ type: "message_update" });
    await tick();
    assert.equal(h.events.latestSequence("s"), before);
  } finally {
    await h.dispose();
  }
});

test("heartbeat timeout detaches without auto-creating a headless runtime", async () => {
  const h = createHarness({
    heartbeatTimeoutMs: 100,
    injectClock: true,
    sweepIntervalMs: 100_000,
  });
  try {
    const request = registerRequest("s");
    const registered = await h.extensionService.register(request);
    assert.equal(registered.ok, true);
    assert.equal(h.broker.executionState("s").state, "native-attached");

    h.clock.value += 1000;
    h.extensionService.sweepExpired();
    assert.equal(h.broker.executionState("s").state, "detached");
    assert.equal(h.service.hasRuntime("s"), false);
    assert.equal(h.state.openSessionCalls.length, 0);

    await h.service.prompt({
      cwd: "/workspace",
      message: "resume",
      requestId: "r1",
      sessionId: "s",
    });
    assert.equal(h.state.openSessionCalls.length, 1);
    assert.equal(h.broker.executionState("s").state, "headless-owned");
  } finally {
    await h.dispose();
  }
});

test("generation fencing still holds after a detach + re-attach cycle", async () => {
  const h = createHarness();
  try {
    const request = registerRequest("s");
    const first = await h.extensionService.register(request);
    await h.extensionService.detach(
      { generation: first.generation, instanceId: request.instanceId },
      first.credential
    );
    const second = await h.extensionService.register(request);
    assert.equal(second.generation, 2);

    const staleIdentity = {
      generation: first.generation,
      instanceId: request.instanceId,
    };
    await assert.rejects(
      h.extensionService.heartbeat(staleIdentity, first.credential),
      (error) => error.status === 409
    );
    await assert.rejects(
      h.extensionService.events(
        { events: [], ...staleIdentity },
        first.credential
      ),
      (error) => error.status === 409
    );
    await assert.rejects(
      h.extensionService.ack(
        {
          commandSequence: 1,
          requestId: "stale",
          status: "accepted",
          ...staleIdentity,
        },
        first.credential
      ),
      (error) => error.status === 409
    );
    const current = await h.extensionService.heartbeat(
      { generation: second.generation, instanceId: request.instanceId },
      second.credential
    );
    assert.equal(current.generation, 2);
  } finally {
    await h.dispose();
  }
});

test("an accepted Prompt marks the Session busy before dispatch settles", async () => {
  let settlePrompt;
  const h = createHarness({
    // A prompt that never settles and never flips `isStreaming`, modelling the
    // window between durable acceptance and the runtime reporting busy.
    prompt: () =>
      new Promise((resolve) => {
        settlePrompt = resolve;
      }),
  });
  try {
    await h.service.open({ cwd: "/workspace", sessionId: "s" });
    const session = h.state.sessions.get("draft-session");
    assert.equal(session.isStreaming, false);

    await h.service.prompt({
      cwd: "/workspace",
      message: "hold the executor",
      requestId: "pending-1",
      sessionId: "s",
    });
    // `prompt()` returned after acceptance while the runtime still reports
    // `isStreaming === false`; the pending mark keeps the Session busy.
    assert.equal(session.isStreaming, false);
    assert.equal(h.service.hasPendingPrompt("s"), true);
    assert.equal(h.service.isRuntimeStreaming("s"), true);
    assert.equal(h.broker.executionState("s").state, "headless-owned");

    const rejected = await h.extensionService.register(registerRequest("s"));
    assert.deepEqual(rejected, { ok: false, reason: "headless_streaming" });
    // No generation was minted and the idle-looking runtime was untouched.
    assert.equal(h.extensionService.generations.get("s"), undefined);
    assert.equal(h.extensionService.executionState("s").state, "detached");
    assert.equal(h.state.releases, 0);
    assert.equal(h.state.disposals, 0);
    assert.equal(h.service.hasRuntime("s"), true);
    assert.equal(h.state.openSessionCalls.length, 1);

    // Settling the in-flight Prompt clears the mark and allow-lists attach.
    settlePrompt();
    await tick();
    assert.equal(h.service.hasPendingPrompt("s"), false);
    assert.equal(h.service.isRuntimeStreaming("s"), false);

    const request = registerRequest("s");
    const registered = await h.extensionService.register(request);
    assert.equal(registered.ok, true);
    assert.equal(registered.generation, 1);
    assert.equal(h.broker.executionState("s").state, "native-attached");

    // Cleanup: detach back to a clean, attachable state (fresh generation).
    await h.extensionService.detach(
      { generation: registered.generation, instanceId: request.instanceId },
      registered.credential
    );
    assert.equal(h.broker.executionState("s").state, "detached");
    assert.equal(h.service.hasPendingPrompt("s"), false);
    const reattached = await h.extensionService.register(registerRequest("s"));
    assert.equal(reattached.ok, true);
    assert.equal(reattached.generation, 2);
  } finally {
    await h.dispose();
  }
});

test("dispatch re-checks ownership and skips a stale dispatch after native attach", async () => {
  // A ledger whose `accept` captures `dispatch` but never invokes it, so the
  // accepted operation can be held open across the attach gate and the stale
  // dispatch replayed after a native attachment takes ownership.
  const captured = {};
  let releaseAccept;
  const operationLedger = {
    accept(operationId, result, dispatch) {
      captured.dispatch = dispatch;
      captured.operationId = operationId;
      captured.result = result;
      return new Promise((resolve) => {
        releaseAccept = () => resolve(result);
      });
    },
  };
  const h = createHarness({ operationLedger });
  try {
    await h.service.open({ cwd: "/workspace", sessionId: "s" });
    const prompting = h.service.prompt({
      cwd: "/workspace",
      message: "captured dispatch",
      requestId: "captured-1",
      sessionId: "s",
    });
    await tick();
    assert.equal(typeof captured.dispatch, "function");
    assert.equal(h.service.hasPendingPrompt("s"), true);

    // While the ledger has accepted but not dispatched, attach is rejected:
    // the same acceptance -> dispatch window the gate must cover on the
    // operationLedger path.
    const rejected = await h.extensionService.register(registerRequest("s"));
    assert.deepEqual(rejected, { ok: false, reason: "headless_streaming" });
    assert.equal(h.extensionService.generations.get("s"), undefined);

    // Settle the pending operation. The mock never invokes `dispatch`, so
    // `prompt()` clears the mark and the Session becomes attachable; the
    // captured dispatch is now stale with respect to the new native owner.
    releaseAccept();
    await prompting;
    assert.equal(h.service.hasPendingPrompt("s"), false);
    assert.equal(h.state.prompts.length, 0);

    const request = registerRequest("s");
    const registered = await h.extensionService.register(request);
    assert.equal(registered.ok, true);
    assert.equal(h.broker.executionState("s").state, "native-attached");

    const appended = [];
    const unsubscribe = h.events.subscribe("s", (record) =>
      appended.push(record)
    );
    captured.dispatch();
    await tick();
    unsubscribe();

    // No second executor started and no success was fabricated.
    assert.equal(h.state.prompts.length, 0);
    assert.equal(h.broker.executionState("s").state, "native-attached");
    const errors = appended.filter((record) => record.type === "omo_error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].payload.message, NATIVE_ATTACHED_PATTERN);

    // Cleanup: detach and confirm the broker is attachable again.
    await h.extensionService.detach(
      { generation: registered.generation, instanceId: request.instanceId },
      registered.credential
    );
    assert.equal(h.broker.executionState("s").state, "detached");
    assert.equal(h.service.hasPendingPrompt("s"), false);
    const reattached = await h.extensionService.register(registerRequest("s"));
    assert.equal(reattached.ok, true);
    assert.equal(reattached.generation, 2);
  } finally {
    await h.dispose();
  }
});
