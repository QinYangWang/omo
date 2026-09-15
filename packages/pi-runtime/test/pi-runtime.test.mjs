import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PI_RUNTIME_CAPABILITIES,
  PI_UPSTREAM_VERSION,
  PiRuntimeAdapter,
} from "../dist/index.js";

const CLOSED_RUNTIME_PATTERN = /Pi runtime is closed/;

test("Pi runtime publishes the pinned compatibility boundary", () => {
  assert.equal(PI_UPSTREAM_VERSION, "0.85.0");
  assert.equal(PI_RUNTIME_CAPABILITIES.stableAgentSessionSdk, true);
  assert.equal(PI_RUNTIME_CAPABILITIES.agentSessionRuntime, true);
  assert.equal(PI_RUNTIME_CAPABILITIES.multiPresentationProtocol, true);
  assert.equal(PI_RUNTIME_CAPABILITIES.codingAgentPresentationFacets, false);
  assert.equal(typeof PI_RUNTIME_CAPABILITIES.protocolVersion, "number");
  assert.equal(Object.isFrozen(PI_RUNTIME_CAPABILITIES), true);
});

test("Pi runtime lists sessions without creating an Agent", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omo-pi-runtime-"));
  const runtime = new PiRuntimeAdapter();
  try {
    assert.deepEqual(await runtime.listSessions(cwd), []);
  } finally {
    await runtime.close();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
  await assert.rejects(runtime.getModelRuntime(), CLOSED_RUNTIME_PATTERN);
});
