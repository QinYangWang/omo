import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { EventStore } = require("../server/event-store.cjs");
const { PiService } = require("../server/pi-service.cjs");

const DRAFT_SESSION_ID = "draft-session";
const DURABLE_SESSION_ID = "durable-session";

test("Session keeps running and persists events while no client is connected", async () => {
  const { OperationLedger } = await import(
    "../packages/host-core/dist/index.js"
  );
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-detached-"));
  const events = new EventStore(dataDir);
  const listeners = [];
  const prompts = [];
  const session = {
    getContextUsage: () => null,
    isStreaming: false,
    model: null,
    prompt(message) {
      prompts.push(message);
      return Promise.resolve();
    },
    sessionFile: "/sessions/detached.jsonl",
    sessionId: DURABLE_SESSION_ID,
    subscribe(listener) {
      listeners.push(listener);
    },
    thinkingLevel: "medium",
  };
  const runtimeAdapter = { openSession: async () => ({ session }) };
  const workspace = { resolveExisting: async (value) => value };
  const operationLedger = new OperationLedger({
    get: (operationId) => Promise.resolve(events.requestResult(operationId)),
    putIfAbsent: (operationId, result) =>
      Promise.resolve(events.saveRequestIfAbsent(operationId, result)),
  });
  const service = new PiService(
    events,
    workspace,
    workspace,
    runtimeAdapter,
    operationLedger
  );
  // The Host keeps this session subscriber alive regardless of clients; it
  // models the Pi session emitting Agent events after a Prompt was accepted.
  const emit = (payload) => listeners[0](payload);

  try {
    // The Host opens the Session; from here it owns the runtime regardless
    // of whether any client is attached.
    const opened = await service.open({
      cwd: "/workspace",
      sessionId: DRAFT_SESSION_ID,
    });
    assert.equal(opened.sessionId, DURABLE_SESSION_ID);
    assert.equal(opened.eventSequence, 0);

    // Client A attaches to the live event stream.
    const deliveredToClient = [];
    const unsubscribeClient = events.subscribe(DRAFT_SESSION_ID, (record) =>
      deliveredToClient.push(record)
    );
    emit({ type: "turn_start" });
    assert.deepEqual(
      deliveredToClient.map((record) => record.type),
      ["turn_start"]
    );

    // Client A detaches: no active event-store subscriber remains.
    unsubscribeClient();
    assert.equal(deliveredToClient.length, 1);

    // A Prompt is dispatched after the client left.
    const accepted = await service.prompt({
      cwd: "/workspace",
      message: "Continue despite no clients",
      requestId: "detached-operation-1",
      sessionId: DRAFT_SESSION_ID,
    });
    assert.equal(accepted.operationId, "detached-operation-1");
    assert.equal(prompts.length, 1);

    // The Session keeps producing Agent events while nobody is connected, and
    // the Host keeps persisting them into the store.
    emit({ delta: "hello", type: "text_delta" });
    emit({ type: "message_stop" });
    assert.equal(
      deliveredToClient.length,
      1,
      "detached clients receive nothing"
    );
    assert.equal(events.latestSequence(DRAFT_SESSION_ID), 3);
    assert.equal(
      events.latestSequence(DURABLE_SESSION_ID),
      3,
      "durable Session ID shares the persisted stream"
    );
    const persisted = events.list(DRAFT_SESSION_ID);
    assert.deepEqual(
      persisted.map((record) => record.type),
      ["turn_start", "text_delta", "message_stop"]
    );
    for (let index = 1; index < persisted.length; index += 1) {
      assert.ok(persisted[index].sequence > persisted[index - 1].sequence);
    }

    // A later Host snapshot still reports everything stored while detached.
    const snapshot = await service.open({
      cwd: "/workspace",
      sessionId: DRAFT_SESSION_ID,
    });
    assert.equal(snapshot.sessionId, DURABLE_SESSION_ID);
    assert.equal(snapshot.eventSequence, 3);

    // Client B reconnects: replay fills the gap left by the detach.
    const deliveredToReconnected = [];
    const unsubscribeReconnected = events.subscribe(
      DRAFT_SESSION_ID,
      (record) => deliveredToReconnected.push(record)
    );
    try {
      const gap = events.list(DRAFT_SESSION_ID, 1);
      assert.deepEqual(
        gap.map((record) => record.type),
        ["text_delta", "message_stop"]
      );
      assert.equal(deliveredToReconnected.length, 0);

      // Once reconnected, live events resume on the same running Session.
      emit({ delta: " world", type: "text_delta" });
      assert.deepEqual(
        deliveredToReconnected.map((record) => record.type),
        ["text_delta"]
      );
    } finally {
      unsubscribeReconnected();
    }
  } finally {
    fs.rmSync(dataDir, { force: true, recursive: true });
  }
});
