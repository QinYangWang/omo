import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CoreHarnessRuntime } from "../src/core-runtime.ts";
import type { AgentRuntimeSession } from "../src/runtime.ts";
import { createFauxModels } from "../src/testing.ts";

/**
 * P0 functional / recovery loop (plan §13 P0, §16 闭环一执行侧):
 * Node + core Harness + SQLite (WAL + FULL) + faux provider, fixed omo
 * operation ids, two watchers on one lane, and accept→close→reopen→drive
 * recovery. Behaviours discovered here are recorded in
 * docs/v2-upstream-verification.md.
 */

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p0-harness-"));
  tempDirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

let faux: ReturnType<typeof createFauxModels>["faux"];
let models: ReturnType<typeof createFauxModels>["models"];
let model: ReturnType<typeof createFauxModels>["model"];

beforeEach(() => {
  ({ faux, model, models } = createFauxModels());
});

const createRuntime = (directory: string): CoreHarnessRuntime =>
  CoreHarnessRuntime.create({ directory, model, models });

test("functional loop: accept with fixed operation id, drive, settled result", async () => {
  faux.setResponses([fauxAssistantMessage("hello from faux")]);
  const runtime = createRuntime(makeDir());
  const session = await runtime.createSession("p0");

  const admission = await session.accept({
    kind: "prompt",
    operationId: "op_fixed_1",
    prompt: "hi",
  });
  assert.equal(admission.ok, true);
  if (admission.ok) {
    assert.equal(admission.value.operationId, "op_fixed_1");
  }

  const driven = await session.drive("op_fixed_1");
  assert.equal(driven.ok, true);
  if (driven.ok && driven.value.kind === "settled") {
    assert.equal(driven.value.result.status, "completed");
  } else {
    assert.fail(`expected settled outcome, got ${JSON.stringify(driven)}`);
  }

  const result = await session.getResult("op_fixed_1");
  assert.equal(result?.status, "completed");

  const info = await session.inspect();
  assert.equal(info.current, null);
  assert.equal(info.lastOperationId, "op_fixed_1");
  assert.notEqual(info.tipId, null);

  const sessions = await runtime.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, session.sessionId);

  await session.close();
  await runtime.close();
});

test("two watchers observe the same lane events (plan §13 P0 多端观察)", async () => {
  faux.setResponses([fauxAssistantMessage("broadcast")]);
  const runtime = createRuntime(makeDir());
  const session = await runtime.createSession();

  const eventsA: string[] = [];
  const eventsB: string[] = [];
  const watchA = await session.watchLane((event) => {
    eventsA.push(event.type);
  });
  const watchB = await session.watchLane((event) => {
    eventsB.push(event.type);
  });
  assert.equal(watchA.snapshot.transcriptLength, 0);
  assert.equal(watchB.snapshot.transcriptLength, 0);

  await session.accept({
    kind: "prompt",
    operationId: "op_watch",
    prompt: "hello",
  });
  const driven = await session.drive("op_watch");
  assert.equal(driven.ok, true);

  for (const required of ["run_start", "message_end", "run_end"]) {
    assert.ok(
      eventsA.includes(required),
      `watcher A missed ${required}: ${eventsA}`
    );
    assert.ok(
      eventsB.includes(required),
      `watcher B missed ${required}: ${eventsB}`
    );
  }

  watchA.unsubscribe();
  watchB.unsubscribe();
  await session.close();
  await runtime.close();
});

test("recovery loop: admitted-but-not-driven operation survives worker restart", async () => {
  faux.setResponses([fauxAssistantMessage("recovered")]);
  const directory = makeDir();

  const runtime1 = createRuntime(directory);
  const crashed = await runtime1.createSession("recoverable");
  const { sessionId } = crashed;
  const admission = await crashed.accept({
    kind: "prompt",
    operationId: "op_RECOVER",
    prompt: "pending work",
  });
  assert.equal(admission.ok, true);
  // Simulated worker death between durable admission and drive.
  await crashed.close();
  await runtime1.close();

  const runtime2 = createRuntime(directory);
  const reopened = await runtime2.openSession(sessionId);
  const open = reopened.openOperations();
  assert.equal(open.length, 1);
  assert.equal(open[0].operationId, "op_RECOVER");
  assert.equal(open[0].lane, "main");

  const driven = await reopened.drive("op_RECOVER");
  assert.equal(driven.ok, true);
  if (driven.ok && driven.value.kind === "settled") {
    assert.equal(driven.value.result.status, "completed");
  } else {
    assert.fail(
      `expected settled outcome after recovery: ${JSON.stringify(driven)}`
    );
  }
  const result = await reopened.getResult("op_RECOVER");
  assert.equal(result?.status, "completed");

  await reopened.close();
  await runtime2.close();
});

test("duplicate accept while the operation is still open is rejected as lane busy", async () => {
  faux.setResponses([fauxAssistantMessage("first")]);
  const runtime = createRuntime(makeDir());
  const session = await runtime.createSession();

  const first = await session.accept({
    kind: "prompt",
    operationId: "op_busy",
    prompt: "one",
  });
  assert.equal(first.ok, true);
  const duplicate = await session.accept({
    kind: "prompt",
    operationId: "op_busy",
    prompt: "one",
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) {
    assert.equal(duplicate.error.code, "lane_busy");
  }

  await session.drive("op_busy");
  await session.close();
  await runtime.close();
});

test("VERIFICATION: duplicate accept after settle silently accepts a second operation (§3.3.3)", async () => {
  // Upstream `accept({ operationId })` is NOT idempotent across settled
  // operations: the same id is admitted again. omo's control-plane inbox must
  // therefore own dedup (same dedup key + payload hash check) and must never
  // re-accept a settled operation id. This test pins the observed behaviour.
  faux.setResponses([
    fauxAssistantMessage("first"),
    fauxAssistantMessage("second"),
  ]);
  const runtime = createRuntime(makeDir());
  const session: AgentRuntimeSession = await runtime.createSession();

  await session.accept({
    kind: "prompt",
    operationId: "op_dup",
    prompt: "one",
  });
  await session.drive("op_dup");

  const second = await session.accept({
    kind: "prompt",
    operationId: "op_dup",
    prompt: "one",
  });
  assert.equal(
    second.ok,
    true,
    "upstream accepted a duplicate operation id after settle"
  );

  await session.close();
  await runtime.close();
});
