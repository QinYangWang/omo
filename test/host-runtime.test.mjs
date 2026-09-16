import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { EventStore } = require("../server/event-store.cjs");
const { loadHostIdentity } = require("../server/host-identity.cjs");
const { PiService } = require("../server/pi-service.cjs");

test("Host identity remains stable in its data directory", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-host-"));
  try {
    const first = loadHostIdentity(dataDir);
    const second = loadHostIdentity(dataDir);
    assert.equal(second, first);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dataDir, "host.json"), "utf8"))
        .hostId,
      first
    );
  } finally {
    fs.rmSync(dataDir, { force: true, recursive: true });
  }
});

test("draft and durable Session IDs share one runtime and event stream", async () => {
  const appended = [];
  const listeners = [];
  const session = {
    sessionId: "durable-session",
    subscribe(listener) {
      listeners.push(listener);
    },
  };
  let createCount = 0;
  const runtimeAdapter = {
    openSession() {
      createCount += 1;
      return { session };
    },
  };
  const events = {
    append(sessionId, event) {
      appended.push({ event, sessionId });
    },
  };
  const workspace = { resolveExisting: async (cwd) => cwd };
  const service = new PiService(events, workspace, workspace, runtimeAdapter);

  const draft = await service.ensure("draft-session", "/workspace");
  const durable = await service.ensure("durable-session", "/workspace");
  listeners[0]({ type: "text_delta" });

  assert.equal(draft, session);
  assert.equal(durable, session);
  assert.equal(createCount, 1);
  assert.deepEqual(appended.map(({ sessionId }) => sessionId).sort(), [
    "draft-session",
    "durable-session",
  ]);
});

test("Host operation ledger accepts a Prompt only once", async () => {
  const { OperationLedger } = await import(
    "../packages/host-core/dist/index.js"
  );
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-operations-"));
  const events = new EventStore(dataDir);
  let promptCount = 0;
  const session = {
    isStreaming: false,
    prompt() {
      promptCount += 1;
      return Promise.resolve();
    },
    sessionFile: "/sessions/session.jsonl",
    sessionId: "durable-session",
    subscribe() {
      return () => undefined;
    },
  };
  const operationLedger = new OperationLedger({
    get: (operationId) => Promise.resolve(events.requestResult(operationId)),
    putIfAbsent: (operationId, result) =>
      Promise.resolve(events.saveRequestIfAbsent(operationId, result)),
  });
  const runtimeAdapter = {
    openSession: () => Promise.resolve({ session }),
  };
  const workspace = { resolveExisting: async (value) => value };
  const service = new PiService(
    events,
    workspace,
    workspace,
    runtimeAdapter,
    operationLedger
  );
  const command = {
    cwd: "/workspace",
    message: "Continue",
    requestId: "operation-1",
    sessionId: "draft-session",
  };

  try {
    const first = await service.prompt(command);
    const duplicate = await service.prompt(command);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(duplicate, first);
    assert.equal(first.operationId, command.requestId);
    assert.equal(promptCount, 1);
  } finally {
    fs.rmSync(dataDir, { force: true, recursive: true });
  }
});
