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
const { handleExtensionAck } = require("../server/host.cjs");
const { PiService } = require("../server/pi-service.cjs");

const CWD = "/workspace";

/**
 * In-process harness for the E4-002 native routing path. It wires the real
 * `EventStore`, `ExtensionService`, `ExecutionBroker` and `PiService` around a
 * mock runtime adapter whose `openSession` call count is the no-headless
 * assertion: a native-routed prompt/abort must never create a headless
 * `AgentSession`.
 *
 * A live command subscriber is modelled by writing directly to the live
 * attachment's `subscriber`, which is the same object `sendCommand` writes to
 * over the real SSE stream. Not attaching a subscriber reproduces the
 * "attachment alive but no live command stream" case (delivery must fail
 * closed rather than fabricate success).
 */
function registerRequest(sessionId, instanceId = crypto.randomUUID()) {
  return {
    capabilities: ["commands", "events"],
    channelVersion: 1,
    extensionVersion: "0.1.0-test",
    instanceId,
    piVersion: "0.85.0-test",
    sessionId,
  };
}

function createMockRuntime() {
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
        getContextUsage: () => ({ contextWindow: 100, percent: 0, tokens: 0 }),
        isIdle: true,
        isStreaming: false,
        model: { id: "test-model", name: "Test Model", provider: "test" },
        prompt(message, options) {
          state.prompts.push({ message, options });
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-native-routing-"));
  const events = new EventStore(dataDir);
  const workspace = { resolveExisting: async (value) => value };
  const { adapter, state } = createMockRuntime();
  const service = new PiService(
    events,
    workspace,
    workspace,
    adapter,
    options.operationLedger
  );
  const warnings = [];
  const logger = {
    warn: (...args) => warnings.push(args),
  };
  let extensionService;
  extensionService = new ExtensionService({
    canAttach: (sessionId) => broker.canAttach(sessionId),
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 120_000,
    hostId: crypto.randomUUID(),
    onAck: (attachment, ack) =>
      handleExtensionAck({
        ack,
        attachment,
        events,
        extensionService,
        logger,
      }),
    onAttachConfirm: (sessionId) => broker.onAttachConfirm(sessionId),
    onDetach: (sessionId) => broker.onDetach(sessionId),
    sweepIntervalMs: 100_000,
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
    dispose() {
      extensionService.dispose();
      service.dispose();
      events.close();
      fs.rmSync(dataDir, { force: true, recursive: true });
    },
    events,
    extensionService,
    logger,
    service,
    state,
    warnings,
  };
}

async function register(h, sessionId, instanceId) {
  const request = registerRequest(sessionId, instanceId);
  const registered = await h.extensionService.register(request);
  assert.equal(registered.ok, true);
  return { registered, request };
}

/**
 * Models a live command subscriber for the current attachment and returns the
 * array of command frames the daemon writes to it.
 */
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

function omoErrors(h, sessionId) {
  return h.events
    .list(sessionId)
    .filter((record) => record.type === "omo_error");
}

test("native prompt dispatches through the broker with a daemon-owned commandSequence", async () => {
  const h = createHarness();
  try {
    await register(h, "s1");
    const commands = attachSubscriber(h, "s1");

    const first = await h.service.prompt({
      cwd: CWD,
      message: "hello native",
      requestId: "req-1",
      sessionId: "s1",
    });
    const second = await h.service.prompt({
      cwd: CWD,
      message: "second native",
      requestId: "req-2",
      sessionId: "s1",
    });

    assert.equal(first.operationId, "req-1");
    assert.equal(second.operationId, "req-2");
    assert.equal(commands.length, 2);
    assert.deepEqual(
      commands.map((command) => command.type),
      ["prompt", "prompt"]
    );
    assert.deepEqual(
      commands.map((command) => command.commandSequence),
      [1, 2]
    );
    assert.deepEqual(
      commands.map((command) => command.requestId),
      ["req-1", "req-2"]
    );
    assert.equal(commands[0].text, "hello native");
    assert.equal(commands[1].text, "second native");

    // The headline rule: routing a native prompt never creates a headless
    // runtime and never touches the adapter.
    assert.equal(h.state.openSessionCalls.length, 0);
    assert.equal(h.service.hasRuntime("s1"), false);
    assert.equal(h.broker.executionState("s1").state, "native-attached");
    assert.equal(omoErrors(h, "s1").length, 0);
  } finally {
    await h.dispose();
  }
});

test("a new attachment generation restarts commandSequence at 1", async () => {
  const h = createHarness();
  try {
    const instanceId = crypto.randomUUID();
    const { registered } = await register(h, "s1", instanceId);
    const commands = attachSubscriber(h, "s1");
    await h.service.prompt({
      cwd: CWD,
      message: "one",
      requestId: "a",
      sessionId: "s1",
    });
    await h.service.prompt({
      cwd: CWD,
      message: "two",
      requestId: "b",
      sessionId: "s1",
    });
    assert.deepEqual(
      commands.map((command) => command.commandSequence),
      [1, 2]
    );

    await h.extensionService.detach(
      {
        generation: registered.generation,
        instanceId,
      },
      registered.credential
    );
    // Detach clears the counter rather than leaking it into the next attach.
    assert.equal(h.broker.commandSequences.size, 0);
    assert.equal(h.broker.commandSequenceKeys.size, 0);

    const reattached = await register(h, "s1", instanceId);
    assert.equal(reattached.registered.generation, 2);
    const nextCommands = attachSubscriber(h, "s1");
    await h.service.prompt({
      cwd: CWD,
      message: "after reattach",
      requestId: "c",
      sessionId: "s1",
    });
    assert.deepEqual(
      nextCommands.map((command) => command.commandSequence),
      [1]
    );
    assert.equal(h.broker.commandSequences.size, 1);
  } finally {
    await h.dispose();
  }
});

test("a prompt with no live subscriber is accepted but reports native_dispatch_unavailable", async () => {
  const h = createHarness();
  try {
    await register(h, "s1");
    const received = [];
    const unsubscribe = h.events.subscribe("s1", (record) =>
      received.push(record)
    );
    const result = await h.service.prompt({
      cwd: CWD,
      message: "nobody is listening",
      requestId: "req-lost",
      sessionId: "s1",
    });
    unsubscribe();

    // The operation stays accepted (durable acceptance is the truth)...
    assert.equal(result.operationId, "req-lost");
    // ...and the failed delivery is an explicit error event, never a fake
    // success or a silent headless fallback.
    const errors = received.filter((record) => record.type === "omo_error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].payload.type, "omo_error");
    assert.equal(errors[0].payload.code, "native_dispatch_unavailable");
    assert.equal(errors[0].payload.requestId, "req-lost");
    assert.equal(errors[0].payload.retryable, true);
    assert.equal(typeof errors[0].payload.message, "string");

    assert.equal(h.state.openSessionCalls.length, 0);
    assert.equal(h.service.hasRuntime("s1"), false);
  } finally {
    await h.dispose();
  }
});

test("images on a native prompt are rejected before any dispatch", async () => {
  const h = createHarness();
  try {
    await register(h, "s1");
    const commands = attachSubscriber(h, "s1");
    await assert.rejects(
      h.service.prompt({
        cwd: CWD,
        images: [{ data: "aGVsbG8=", mimeType: "image/png", type: "image" }],
        message: "with image",
        requestId: "req-image",
        sessionId: "s1",
      }),
      (error) =>
        error.statusCode === 400 &&
        error.code === "native_prompt_images_unsupported"
    );
    assert.equal(commands.length, 0);
    assert.equal(h.state.openSessionCalls.length, 0);
    assert.equal(h.broker.executionState("s1").state, "native-attached");
  } finally {
    await h.dispose();
  }
});

test("abort routes to the native owner and reports delivery failure as omo_error", async () => {
  const h = createHarness();
  try {
    await register(h, "s1");
    const commands = attachSubscriber(h, "s1");
    assert.deepEqual(await h.service.abort("s1"), { sessionId: "s1" });
    assert.equal(commands.length, 1);
    assert.equal(commands[0].type, "abort");
    assert.equal(commands[0].commandSequence, 1);
    assert.equal(typeof commands[0].requestId, "string");
    assert.ok(commands[0].requestId.length > 0);

    // No live subscriber: accepted contract-wise, surfaced as an error.
    await register(h, "s2");
    assert.deepEqual(await h.service.abort("s2"), { sessionId: "s2" });
    const errors = omoErrors(h, "s2");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].payload.code, "native_dispatch_unavailable");
    assert.equal(errors[0].payload.retryable, true);
    assert.equal(typeof errors[0].payload.requestId, "string");

    // No headless runtime on either native path.
    assert.equal(h.state.openSessionCalls.length, 0);
    assert.equal(h.service.hasRuntime("s1"), false);
    assert.equal(h.service.hasRuntime("s2"), false);
  } finally {
    await h.dispose();
  }
});

test("headless abort keeps using the in-process runtime", async () => {
  const h = createHarness();
  try {
    await h.service.open({ cwd: CWD, sessionId: "s1" });
    assert.equal(h.state.openSessionCalls.length, 1);
    await h.service.abort("s1");
    assert.equal(h.state.aborts, 1);
    assert.equal(h.state.openSessionCalls.length, 1);
    assert.equal(h.broker.executionState("s1").state, "headless-owned");
  } finally {
    await h.dispose();
  }
});

test("stop-native-input aborts the native owner and reports delivery", async () => {
  const h = createHarness();
  try {
    await register(h, "s1");
    const commands = attachSubscriber(h, "s1");
    assert.deepEqual(await h.service.stopNativeInput("s1"), { ok: true });
    assert.equal(commands.length, 1);
    assert.equal(commands[0].type, "abort");

    // Attachment alive but no command stream: best-effort reports false.
    await register(h, "s2");
    assert.deepEqual(await h.service.stopNativeInput("s2"), { ok: false });
    assert.equal(omoErrors(h, "s2").length, 1);

    // A headless session keeps the in-process abort behavior.
    await h.service.open({ cwd: CWD, sessionId: "s3" });
    assert.deepEqual(await h.service.stopNativeInput("s3"), { ok: true });
    assert.equal(h.state.aborts, 1);

    // Neither owner: the historical `session_not_found` shape is preserved.
    await assert.rejects(
      h.service.stopNativeInput("s4"),
      (error) => error.code === "session_not_found"
    );

    assert.equal(h.state.openSessionCalls.length, 1);
  } finally {
    await h.dispose();
  }
});

test("rejected acks surface once on the right session; other statuses stay silent", async () => {
  const h = createHarness();
  try {
    const { registered, request } = await register(h, "s1");
    const identity = {
      generation: registered.generation,
      instanceId: request.instanceId,
    };

    await h.extensionService.ack(
      {
        commandSequence: 1,
        reason: "turn_already_running",
        requestId: "ack-rejected",
        status: "rejected",
        ...identity,
      },
      registered.credential
    );
    await h.extensionService.ack(
      {
        commandSequence: 2,
        requestId: "ack-accepted",
        status: "accepted",
        ...identity,
      },
      registered.credential
    );
    await h.extensionService.ack(
      {
        commandSequence: 3,
        requestId: "ack-completed",
        status: "completed",
        ...identity,
      },
      registered.credential
    );

    const errors = omoErrors(h, "s1");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].payload.type, "omo_error");
    assert.equal(errors[0].payload.code, "extension_command_rejected");
    assert.equal(errors[0].payload.message, "turn_already_running");
    assert.equal(errors[0].payload.requestId, "ack-rejected");
    assert.equal(errors[0].payload.retryable, true);

    // A late ack after detach is fenced by the attachment registry: no event.
    await h.extensionService.detach(identity, registered.credential);
    await assert.rejects(
      h.extensionService.ack(
        {
          commandSequence: 4,
          reason: "late",
          requestId: "ack-late",
          status: "rejected",
          ...identity,
        },
        registered.credential
      ),
      (error) => error.status === 409
    );
    assert.equal(omoErrors(h, "s1").length, 1);

    // The handler itself also fails closed if it is ever invoked with an
    // attachment that is no longer current: log only, never an event.
    handleExtensionAck({
      ack: {
        generation: registered.generation,
        instanceId: request.instanceId,
        requestId: "ack-orphan",
        status: "rejected",
      },
      attachment: { sessionId: "s1" },
      events: h.events,
      extensionService: h.extensionService,
      logger: h.logger,
    });
    assert.equal(omoErrors(h, "s1").length, 1);
    assert.equal(h.warnings.length, 1);
  } finally {
    await h.dispose();
  }
});

test("a requestId replay may dispatch again and the Extension is the dedupe boundary", async () => {
  // A ledger that never remembers an operation models the retry after a crash
  // BEFORE durable acceptance was persisted, so the broker dispatches again
  // with the same requestId (at-least-once). The Extension is the
  // duplicate-safe boundary: it tracks seen requestIds per attachment and
  // rejects a duplicate instead of starting a second native turn. With the
  // real `OperationLedger` the second call returns the stored acceptance and
  // does not dispatch, which is the complementary half of the same contract.
  const ledger = {
    accept: async (_operationId, result, dispatch) => {
      await dispatch();
      return result;
    },
  };
  const h = createHarness({ operationLedger: ledger });
  try {
    await register(h, "s1");
    const commands = attachSubscriber(h, "s1");
    await h.service.prompt({
      cwd: CWD,
      message: "first",
      requestId: "dup-request",
      sessionId: "s1",
    });
    await h.service.prompt({
      cwd: CWD,
      message: "retry",
      requestId: "dup-request",
      sessionId: "s1",
    });
    assert.equal(commands.length, 2);
    assert.deepEqual(
      commands.map((command) => command.requestId),
      ["dup-request", "dup-request"]
    );
    assert.deepEqual(
      commands.map((command) => command.commandSequence),
      [1, 2]
    );
  } finally {
    await h.dispose();
  }
});

test("every omo_error payload carries the documented error shape", async () => {
  // NOTE: the current frozen contracts do not export an
  // `OmoErrorEventPayloadSchema`; this asserts the exact shape the contract
  // requires (`type`, `code`, `message`, `retryable`, plus extras) so the
  // pi-adapter can surface it.
  const h = createHarness();
  try {
    await register(h, "s1");
    await h.service.prompt({
      cwd: CWD,
      message: "no subscriber",
      requestId: "shape-error",
      sessionId: "s1",
    });
    const { registered, request } = await register(h, "s3");
    await h.extensionService.ack(
      {
        commandSequence: 1,
        generation: registered.generation,
        instanceId: request.instanceId,
        reason: "turn_already_running",
        requestId: "shape-ack",
        status: "rejected",
      },
      registered.credential
    );

    const errors = [...omoErrors(h, "s1"), ...omoErrors(h, "s3")];
    assert.ok(errors.length >= 2);
    for (const record of errors) {
      const { payload } = record;
      assert.deepEqual(Object.keys(payload).sort(), [
        "code",
        "message",
        "requestId",
        "retryable",
        "type",
      ]);
      assert.equal(payload.type, "omo_error");
      assert.equal(typeof payload.code, "string");
      assert.ok(payload.code.length > 0);
      assert.equal(typeof payload.message, "string");
      assert.ok(payload.message.length > 0);
      assert.equal(typeof payload.retryable, "boolean");
      assert.equal(typeof payload.requestId, "string");
      assert.ok(payload.requestId.length > 0);
    }
  } finally {
    await h.dispose();
  }
});
