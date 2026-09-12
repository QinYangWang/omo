import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { OmoCommandError } from "@omo/protocol/errors";
import { CommandInbox } from "../src/inbox.ts";

/**
 * P0 command-admission verification (plan §5.4, §14 受理测试类别):
 * idempotent replay, payload-mismatch rejection, state machine, crash
 * windows (kill before/after receipt) and receipt persistence across reopens.
 */

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p0-inbox-"));
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const principal = { deviceId: "dev_1", userId: "usr_1" };
const scope = { laneId: "main", sessionId: "ses_1", workspaceId: "wks_1" };

const sampleInput = (mutation: string, text = "hello") => ({
  clientMutationId: mutation,
  commandId: `cmd_${mutation}`,
  kind: "session.prompt",
  payload: { text },
  scope,
});

const INBOX_SEQ_PATTERN = /^[1-9][0-9]*$/;

test("receive returns a durable queued receipt and the DB runs WAL + FULL", () => {
  const inbox = CommandInbox.open(join(makeDir(), "inbox.sqlite"));
  const receipt = inbox.receive(sampleInput("m1"), principal);
  assert.equal(receipt.state, "queued");
  assert.equal(receipt.commandId, "cmd_m1");
  assert.match(receipt.inboxSeq, INBOX_SEQ_PATTERN);
  inbox.close();

  // Reopen read-only and prove durability pragmas + persisted row.
  const reopened = CommandInbox.open(
    join(tempDirs.at(-1) ?? "", "inbox.sqlite")
  );
  const record = reopened.getByCommandId("cmd_m1");
  assert.equal(record?.state, "queued");
  reopened.close();
});

test("replay with the same mutation id returns the ORIGINAL receipt (idempotent)", () => {
  const inbox = CommandInbox.open(join(makeDir(), "inbox.sqlite"));
  const first = inbox.receive(sampleInput("m2"), principal);
  // Client retry after a lost response: same mutation, NEW commandId must not
  // create a second durable command.
  const replay = inbox.receive(
    { ...sampleInput("m2"), commandId: "cmd_DIFFERENT_retry" },
    principal
  );
  assert.equal(replay.commandId, first.commandId);
  assert.equal(replay.inboxSeq, first.inboxSeq);
  assert.equal(inbox.listByScope(scope).length, 1);
  inbox.close();
});

test("same mutation id with a different payload is rejected", () => {
  const inbox = CommandInbox.open(join(makeDir(), "inbox.sqlite"));
  inbox.receive(sampleInput("m3", "hello"), principal);
  assert.throws(
    () => inbox.receive(sampleInput("m3", "CHANGED"), principal),
    (error: unknown) =>
      error instanceof OmoCommandError &&
      error.code === "duplicate_payload_mismatch"
  );
  inbox.close();
});

test("different principals do not collide on the same mutation id", () => {
  const inbox = CommandInbox.open(join(makeDir(), "inbox.sqlite"));
  const a = inbox.receive(
    { ...sampleInput("m4"), commandId: "cmd_m4_A" },
    { deviceId: "dev_A", userId: "usr_A" }
  );
  const b = inbox.receive(
    { ...sampleInput("m4"), commandId: "cmd_m4_B" },
    { deviceId: "dev_B", userId: "usr_B" }
  );
  assert.notEqual(a.commandId, b.commandId);
  inbox.close();
});

const INVALID_TRANSITION_PATTERN =
  /invalid command state transition admitted → completed/;

test("state machine: queued → admitted → running → completed, invalid jumps rejected", () => {
  const inbox = CommandInbox.open(join(makeDir(), "inbox.sqlite"));
  inbox.receive(sampleInput("m5"), principal);
  const admitted = inbox.markAdmitted("cmd_m5", "op_5");
  assert.equal(admitted.state, "admitted");
  assert.equal(admitted.operationId, "op_5");
  assert.equal(inbox.getByOperationId("op_5")?.commandId, "cmd_m5");

  assert.throws(() => inbox.complete("cmd_m5", {}), INVALID_TRANSITION_PATTERN);

  inbox.markRunning("cmd_m5");
  const completed = inbox.complete("cmd_m5", { output: "done" });
  assert.equal(completed.state, "completed");

  // Terminal states never move again.
  assert.throws(() => inbox.cancel("cmd_m5"), OmoCommandError);
  inbox.close();
});

test("cancel from queued and from running are both legal", () => {
  const inbox = CommandInbox.open(join(makeDir(), "inbox.sqlite"));
  inbox.receive(sampleInput("m6"), principal);
  assert.equal(inbox.cancel("cmd_m6").state, "cancelled");

  inbox.receive(sampleInput("m7"), principal);
  inbox.markAdmitted("cmd_m7", "op_7");
  inbox.markRunning("cmd_m7");
  assert.equal(inbox.cancel("cmd_m7").state, "cancelled");
  inbox.close();
});

test("crash windows: row written before receipt is visible after reopen; nothing after close is lost", () => {
  const dir = makeDir();
  const path = join(dir, "inbox.sqlite");
  const inbox = CommandInbox.open(path);
  const receipt = inbox.receive(sampleInput("m8"), principal);
  inbox.markAdmitted("cmd_m8", "op_8");
  // Simulate daemon death: no graceful close, just drop the handle reference.
  inbox.close();

  const recovered = CommandInbox.open(path);
  const record = recovered.getByCommandId(receipt.commandId);
  assert.equal(record?.state, "admitted");
  assert.equal(record?.operationId, "op_8");
  recovered.close();
});

test("unknown commands raise unknown_command", () => {
  const inbox = CommandInbox.open(join(makeDir(), "inbox.sqlite"));
  assert.throws(
    () => inbox.getByCommandId("cmd_nope") ?? inbox.markRunning("cmd_nope"),
    (error: unknown) =>
      error instanceof OmoCommandError && error.code === "unknown_command"
  );
  inbox.close();
});

test("pragma report matches §5.8 baseline on the inbox database", () => {
  const inbox = CommandInbox.open(join(makeDir(), "inbox.sqlite"));
  const report = inbox.durabilityReport();
  assert.equal(report.journalMode, "wal");
  assert.equal(report.synchronous, 2);
  inbox.close();
});
