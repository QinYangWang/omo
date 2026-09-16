import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { EventStore } = require("../server/event-store.cjs");
const { PiService } = require("../server/pi-service.cjs");
const { OperationLedger } = await import("../packages/host-core/dist/index.js");

function createDataDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `omo-${label}-`));
}

/**
 * Builds a PiService with the real EventStore-backed operation ledger,
 * exactly like server/index.cjs wires it, but with a fake Pi runtime
 * whose session.prompt() only records calls.
 */
function createService(dataDir, session) {
  const events = new EventStore(dataDir);
  const operationLedger = new OperationLedger({
    get: (operationId) => Promise.resolve(events.requestResult(operationId)),
    putIfAbsent: (operationId, result) =>
      Promise.resolve(events.saveRequestIfAbsent(operationId, result)),
  });
  const workspace = { resolveExisting: async (value) => value };
  const runtimeAdapter = {
    openSession: () => Promise.resolve({ session }),
  };
  const service = new PiService(
    events,
    workspace,
    workspace,
    runtimeAdapter,
    operationLedger
  );
  return { events, service };
}

function createFakeSession({ onPrompt } = {}) {
  const calls = [];
  const session = {
    isStreaming: false,
    prompt(message, options) {
      calls.push({ message, options });
      const result = onPrompt?.(message, options);
      return result ?? Promise.resolve();
    },
    sessionFile: "/sessions/session.jsonl",
    sessionId: "durable-session",
    subscribe() {
      return () => undefined;
    },
  };
  return { calls, session };
}

const promptCommand = {
  cwd: "/workspace",
  message: "Continue",
  requestId: "concurrent-request-1",
  sessionId: "draft-session",
};

test("concurrent duplicate requestIds dispatch the Prompt exactly once", async () => {
  const dataDir = createDataDir("prompt-idempotency");
  const { calls, session } = createFakeSession();
  const { events, service } = createService(dataDir, session);
  try {
    const duplicates = await Promise.all(
      Array.from({ length: 8 }, () => service.prompt(promptCommand))
    );
    for (const result of duplicates) {
      assert.deepEqual(result, duplicates[0]);
    }
    assert.equal(duplicates[0].operationId, promptCommand.requestId);
    assert.equal(
      duplicates[0].sessionId,
      session.sessionId,
      "acceptance carries the durable session id"
    );
    assert.equal(calls.length, 1, "session.prompt runs exactly once");
    assert.equal(calls[0].message, promptCommand.message);

    const rows = events.db
      .prepare("SELECT COUNT(*) AS count FROM requests WHERE request_id = ?")
      .get(promptCommand.requestId);
    assert.equal(rows.count, 1, "acceptance persisted exactly once");
    assert.deepEqual(
      events.requestResult(promptCommand.requestId),
      duplicates[0],
      "retry reads the same persisted acceptance"
    );
  } finally {
    fs.rmSync(dataDir, { force: true, recursive: true });
  }
});

test("duplicate requestId deduplicates while the first Prompt is still running", async () => {
  const dataDir = createDataDir("prompt-inflight");
  let releaseFirst;
  const firstPrompt = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const { calls, session } = createFakeSession({
    onPrompt: () => firstPrompt,
  });
  const { service } = createService(dataDir, session);

  const first = service.prompt(promptCommand);
  const inFlight = service.prompt(promptCommand);
  const [firstResult, duplicateResult] = await Promise.all([first, inFlight]);
  try {
    assert.equal(calls.length, 1, "no second dispatch while in flight");
    assert.deepEqual(duplicateResult, firstResult);
  } finally {
    releaseFirst();
    fs.rmSync(dataDir, { force: true, recursive: true });
  }
});

test("distinct requestIds dispatch independently", async () => {
  const dataDir = createDataDir("prompt-distinct");
  const { calls, session } = createFakeSession();
  const { service } = createService(dataDir, session);
  try {
    const first = await service.prompt({
      ...promptCommand,
      requestId: "request-a",
    });
    const second = await service.prompt({
      ...promptCommand,
      requestId: "request-b",
    });
    assert.notEqual(first.operationId, second.operationId);
    assert.equal(calls.length, 2);
  } finally {
    fs.rmSync(dataDir, { force: true, recursive: true });
  }
});

test("crash between acceptance persistence and dispatch suppresses the Prompt on retry", async () => {
  const dataDir = createDataDir("prompt-crash-window");
  const { events } = createService(dataDir, createFakeSession().session);
  try {
    // Simulate a crash after `putIfAbsent` persisted the acceptance but
    // before `dispatch()` invoked session.prompt(): persist the response now
    // without dispatching, then restart with the same requestId.
    const accepted = events.saveRequestIfAbsent(promptCommand.requestId, {
      operationId: promptCommand.requestId,
      sessionFile: "/sessions/session.jsonl",
      sessionId: "durable-session",
    });
    assert.equal(accepted.inserted, true);

    let promptCalls = 0;
    const { session } = createFakeSession({
      onPrompt: () => {
        promptCalls += 1;
        return Promise.resolve();
      },
    });
    const restarted = createService(dataDir, session);
    const result = await restarted.service.prompt(promptCommand);
    assert.equal(promptCalls, 0, "crash window never dispatches again");
    assert.deepEqual(
      result,
      accepted.result,
      "returns the persisted acceptance"
    );
  } finally {
    fs.rmSync(dataDir, { force: true, recursive: true });
  }
});
