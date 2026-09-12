/**
 * P0 experiment 1 — functional / recovery loop (plan §13 P0, §16 闭环一执行侧).
 *
 * Proves with the pinned upstream versions:
 *   1. AgentHarness + SqliteSessionRepo (WAL + FULL) + faux provider runs a
 *      prompt end-to-end under an omo-assigned fixed operation id.
 *   2. accept() persists admission: closing and reopening the session
 *      surfaces the unfinished operation, and driving it completes.
 *   3. accept() with a duplicate operation id after settle silently accepts
 *      and BLOCKS the lane until that duplicate is driven (§3.3.3) — omo must
 *      dedup in the control-plane inbox, never re-accept a settled id.
 *
 * Run: node --no-warnings experiments/p0/harness-recovery.mjs
 * Exit code 0 = all assertions held; a report is printed to stdout.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CoreHarnessRuntime } from "@omo/agent-runtime/core-runtime";
import { createFauxModels } from "@omo/agent-runtime/testing";

const directory = mkdtempSync(join(tmpdir(), "omo-p0-experiment-"));
const report = { assertions: [], directory, ok: /** @type {boolean} */ (true) };
const check = (name, condition, detail = "") => {
  report.assertions.push({ detail, name, ok: condition });
  if (!condition) {
    report.ok = false;
  }
};

try {
  const { faux, model, models } = createFauxModels();
  faux.setResponses([
    fauxAssistantMessage("first answer"),
    fauxAssistantMessage("duplicate answer"),
    fauxAssistantMessage("recovered answer"),
  ]);

  // --- Session A: functional loop + duplicate-id behaviour -----------------
  const runtime1 = CoreHarnessRuntime.create({ directory, model, models });
  const sessionA = await runtime1.createSession("p0-functional");

  const admission = await sessionA.accept({
    kind: "prompt",
    operationId: "op_P0_1",
    prompt: "say hello",
  });
  check("functional.accept.fixedOperationId", admission.ok === true);

  const driven = await sessionA.drive("op_P0_1");
  check(
    "functional.drive.settledCompleted",
    driven.ok &&
      driven.value.kind === "settled" &&
      driven.value.result.status === "completed",
    JSON.stringify(driven)
  );
  const result = await sessionA.getResult("op_P0_1");
  check("functional.getResult.completed", result?.status === "completed");

  const duplicate = await sessionA.accept({
    kind: "prompt",
    operationId: "op_P0_1",
    prompt: "say hello",
  });
  check(
    "dedup.duplicateAfterSettle.silentlyAccepted",
    duplicate.ok === true,
    "upstream accept() re-admits a settled operation id; omo inbox must dedup"
  );
  const blocked = await sessionA.accept({
    kind: "prompt",
    operationId: "op_P0_OTHER",
    prompt: "other work",
  });
  check(
    "dedup.laneBlockedByUndrivenDuplicate",
    blocked.ok === false && blocked.error.code === "lane_busy",
    JSON.stringify(blocked)
  );
  const unblocked = await sessionA.drive("op_P0_1");
  check(
    "dedup.drivingDuplicateUnblocksLane",
    unblocked.ok && unblocked.value.kind === "settled",
    JSON.stringify(unblocked)
  );
  await sessionA.close();

  // --- Session B: recovery loop --------------------------------------------
  const sessionB = await runtime1.createSession("p0-recovery");
  const { sessionId } = sessionB;
  const pending = await sessionB.accept({
    kind: "prompt",
    operationId: "op_P0_PENDING",
    prompt: "unfinished work",
  });
  check("recovery.accept.pending", pending.ok === true);
  await sessionB.close();
  await runtime1.close();

  const runtime2 = CoreHarnessRuntime.create({ directory, model, models });
  const reopened = await runtime2.openSession(sessionId);
  const open = reopened.openOperations();
  check(
    "recovery.openOperationListed",
    open.some((operation) => operation.operationId === "op_P0_PENDING"),
    JSON.stringify(open)
  );
  const recoveredDrive = await reopened.drive("op_P0_PENDING");
  check(
    "recovery.driveCompletes",
    recoveredDrive.ok &&
      recoveredDrive.value.kind === "settled" &&
      recoveredDrive.value.result.status === "completed",
    JSON.stringify(recoveredDrive)
  );

  await reopened.close();
  await runtime2.close();
} finally {
  console.log(JSON.stringify(report, null, 2));
  rmSync(directory, { force: true, recursive: true });
  process.exit(report.assertions.every((assertion) => assertion.ok) ? 0 : 1);
}
