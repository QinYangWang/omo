import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { InteractionStore } from "../src/interactions.ts";

/**
 * P0 Interaction transaction boundary (plan §7.6, §13 P0):
 * request persisted before projection, first-writer-wins answers in one
 * transaction, eligibility, revision CAS, and recovery after restart.
 */

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p0-interaction-"));
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const scope = { laneId: "main", sessionId: "ses_1", workspaceId: "wks_1" };
const eligible = ["usr_1/dev_1", "usr_1/dev_2"];

const newApproval = (id: string) => ({
  eligiblePrincipals: eligible,
  interactionId: id,
  invocationId: `inv_${id}`,
  pluginGeneration: "gen_1",
  request: { question: "Allow file write?", schema: "confirm" },
  schemaVersion: 1,
  scope,
});

test("create persists a pending interaction", () => {
  const store = InteractionStore.open(join(makeDir(), "cp.sqlite"));
  const created = store.create(newApproval("int_1"));
  assert.equal(created.status, "pending");
  assert.equal(created.revision, 1);
  assert.deepEqual(created.eligiblePrincipals, eligible);
  assert.equal(store.listPending().length, 1);
  store.close();
});

test("first writer wins: second answer observes the completed state", () => {
  const store = InteractionStore.open(join(makeDir(), "cp.sqlite"));
  store.create(newApproval("int_2"));

  const first = store.answer("int_2", "usr_1/dev_1", { approved: true }, 1);
  assert.equal(first.ok, true);

  const second = store.answer("int_2", "usr_1/dev_2", { approved: false }, 1);
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.code, "already_answered");
    assert.equal(second.record?.answeredBy, "usr_1/dev_1");
  }

  const record = store.get("int_2");
  assert.equal(record?.status, "answered");
  assert.equal(record?.revision, 2);
  assert.deepEqual(record?.answer, { approved: true });
  assert.equal(store.listPending().length, 0);
  store.close();
});

test("revision mismatch is rejected before answering", () => {
  const store = InteractionStore.open(join(makeDir(), "cp.sqlite"));
  store.create(newApproval("int_3"));
  const stale = store.answer("int_3", "usr_1/dev_1", { approved: true }, 99);
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.code, "revision_mismatch");
  }
  assert.equal(store.get("int_3")?.status, "pending");
  store.close();
});

test("ineligible principals cannot answer", () => {
  const store = InteractionStore.open(join(makeDir(), "cp.sqlite"));
  store.create(newApproval("int_4"));
  const denied = store.answer("int_4", "usr_2/dev_9", { approved: true });
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.code, "not_eligible");
  }
  assert.equal(store.get("int_4")?.status, "pending");
  store.close();
});

test("cancel closes the interaction without an answer", () => {
  const store = InteractionStore.open(join(makeDir(), "cp.sqlite"));
  store.create(newApproval("int_5"));
  const cancelled = store.cancel("int_5");
  assert.equal(cancelled.status, "cancelled");
  const late = store.answer("int_5", "usr_1/dev_1", { approved: true });
  assert.equal(late.ok, false);
  if (!late.ok) {
    assert.equal(late.code, "not_pending");
  }
  store.close();
});

test("restart rebuilds pending interactions from durable state (§7.6)", () => {
  const path = join(makeDir(), "cp.sqlite");
  const store = InteractionStore.open(path);
  store.create(newApproval("int_6"));
  const answered = store.answer("int_6", "usr_1/dev_2", { approved: true }, 1);
  assert.equal(answered.ok, true);
  store.create(newApproval("int_7"));
  // Simulated daemon death.
  store.close();

  const reopened = InteractionStore.open(path);
  assert.equal(reopened.get("int_6")?.status, "answered");
  assert.deepEqual(reopened.get("int_6")?.answer, { approved: true });
  const pending = reopened.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].interactionId, "int_7");
  // A late duplicate answer after restart still loses.
  const late = reopened.answer("int_6", "usr_1/dev_1", { approved: false }, 1);
  assert.equal(late.ok, false);
  reopened.close();
});

test("durability report matches the §5.8 baseline", () => {
  const store = InteractionStore.open(join(makeDir(), "cp.sqlite"));
  const report = store.durabilityReport();
  assert.equal(report.journalMode, "wal");
  assert.equal(report.synchronous, 2);
  store.close();
});
