import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PiRuntimeAdapter } from "../dist/index.js";

const CLOSED_RUNTIME_PATTERN = /Pi runtime is closed/;

test("Pi runtime does not advertise unintegrated capabilities", () => {
  const runtime = new PiRuntimeAdapter();
  assert.equal("capabilities" in runtime, false);
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
