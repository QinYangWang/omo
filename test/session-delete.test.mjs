import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { PiService } = require("../server/pi-service.cjs");

function createFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "omo-delete-session-")
  );
  const sessionPath = path.join(directory, "session.jsonl");
  fs.writeFileSync(sessionPath, "session\n");
  const adapter = {
    openSessionDocument: () => ({ getSessionId: () => "session-id" }),
  };
  const workspace = {
    resolveExisting: async (candidate) => path.resolve(candidate),
  };
  const deletedEventSessions = [];
  const service = new PiService(
    {
      append: () => undefined,
      deleteSession: (sessionId) => deletedEventSessions.push(sessionId),
    },
    workspace,
    workspace,
    adapter
  );
  return { deletedEventSessions, directory, service, sessionPath };
}

test("permanently deletes an idle Session file", async () => {
  const fixture = createFixture();
  try {
    await fixture.service.deleteSession(fixture.sessionPath);
    assert.equal(fs.existsSync(fixture.sessionPath), false);
    assert.deepEqual(fixture.deletedEventSessions, ["session-id"]);
  } finally {
    fixture.service.dispose();
    fs.rmSync(fixture.directory, { force: true, recursive: true });
  }
});

test("refuses to delete a Session attached to native Pi", async () => {
  const fixture = createFixture();
  fixture.service.setExecutionBroker({
    nativeAttached: () => true,
  });
  try {
    await assert.rejects(fixture.service.deleteSession(fixture.sessionPath), {
      code: "session_native_attached",
      statusCode: 409,
    });
    assert.equal(fs.existsSync(fixture.sessionPath), true);
  } finally {
    fixture.service.dispose();
    fs.rmSync(fixture.directory, { force: true, recursive: true });
  }
});

test("refuses to delete a Session while its runtime is being created", async () => {
  const fixture = createFixture();
  fixture.service.sessions.set("session-id", new Promise(() => undefined));
  try {
    await assert.rejects(fixture.service.deleteSession(fixture.sessionPath), {
      code: "session_running",
      statusCode: 409,
    });
    assert.equal(fs.existsSync(fixture.sessionPath), true);
  } finally {
    fixture.service.sessions.clear();
    fixture.service.dispose();
    fs.rmSync(fixture.directory, { force: true, recursive: true });
  }
});
