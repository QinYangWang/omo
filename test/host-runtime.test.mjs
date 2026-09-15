import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
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
  const sdk = Promise.resolve({
    createAgentSession() {
      createCount += 1;
      return { session };
    },
    ModelRuntime: { create: () => ({}) },
    SessionManager: { create: (cwd) => ({ cwd }) },
  });
  const events = {
    append(sessionId, event) {
      appended.push({ event, sessionId });
    },
  };
  const workspace = { resolveExisting: async (cwd) => cwd };
  const service = new PiService(events, workspace, workspace, sdk);

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
