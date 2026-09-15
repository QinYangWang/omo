import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { CommandInbox } from "@omo/control-plane/inbox";
import { OmoCommandError } from "@omo/protocol/errors";
import { openDurableDatabase } from "@omo/storage/durable-database";
import { openDaemon } from "../src/daemon.ts";
import { WorkspaceRegistry } from "../src/workspaces.ts";
import {
  FakeRuntime,
  FakeSessionStore,
  waitFor,
} from "./helpers/fake-runtime.ts";

/**
 * P1 assembly verification (plan §13 P1, §5.4/§5.5): the modular daemon wires
 * CommandInbox + InteractionStore + AgentRuntime + Supervisor into one
 * process with durable receipts, dedup, cross-database crash reconciliation
 * and single-writer ownership. Runtime semantics are faked at the documented
 * upstream boundaries; the e2e suite re-proves the flow against the REAL
 * CoreHarnessRuntime + faux provider.
 */

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p1-daemon-"));
  tempDirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const PRINCIPAL = { deviceId: "dev_test", userId: "usr_test" };

interface StartedDaemon {
  daemon: ReturnType<typeof openDaemon>;
  dataDir: string;
  rootDir: string;
  store: FakeSessionStore;
  workspaceId: string;
}

const startDaemon = (options?: {
  closeGraceMs?: number;
  dataDir?: string;
  rootDir?: string;
  store?: FakeSessionStore;
}): StartedDaemon => {
  const dataDir = options?.dataDir ?? makeDir();
  const rootDir = options?.rootDir ?? makeDir();
  const store = options?.store ?? new FakeSessionStore();
  const daemon = openDaemon({
    closeGraceMs: options?.closeGraceMs,
    dataDir,
    pairingCode: "code",
    runtime: new FakeRuntime(store),
    workspaceRoots: [rootDir],
  });
  // Re-registration is idempotent by canonical path, so restart cases get
  // the original record back.
  const workspaceDir = join(rootDir, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const workspace = daemon.workspaces.register({ path: workspaceDir });
  return {
    daemon,
    dataDir,
    rootDir,
    store,
    workspaceId: workspace.workspaceId,
  };
};

const createSessionViaService = async (
  service: ReturnType<typeof openDaemon>["service"],
  workspaceId: string
): Promise<string> => {
  service.submit(
    {
      clientMutationId: `create-${Date.now()}-${Math.random()}`,
      commandId: `cmd_create_${Date.now()}_${Math.random()}`,
      kind: "session.create",
      payload: { name: "test session" },
      scope: { workspaceId },
    },
    PRINCIPAL
  );
  const record = await waitFor(() => {
    const commands = service.listCommands({ workspaceId });
    const created = commands.find(
      (command) =>
        command.kind === "session.create" && command.state === "completed"
    );
    return created;
  });
  const result = record.result as { sessionId: string };
  return result.sessionId;
};

test("submit → durable receipt → serialized execution → completed result", async () => {
  const { daemon, store, workspaceId } = startDaemon();
  const sessionId = await createSessionViaService(daemon.service, workspaceId);

  const receipt = daemon.service.submit(
    {
      clientMutationId: "mut-1",
      commandId: "cmd_prompt_1",
      kind: "prompt",
      payload: { prompt: "hello" },
      scope: { laneId: "main", sessionId, workspaceId },
    },
    PRINCIPAL
  );
  assert.equal(receipt.state, "queued");
  assert.equal(receipt.commandId, "cmd_prompt_1");
  assert.ok(
    receipt.operationId?.startsWith("op_"),
    "prompt receipt carries the stable operation id fixed at admission"
  );

  const record = await waitFor(() => {
    const candidate = daemon.service.getCommand("cmd_prompt_1");
    return candidate?.state === "completed" ? candidate : undefined;
  });
  const result = record.result as { status: string; operationId: string };
  assert.equal(result.status, "completed");
  assert.equal(result.operationId, receipt.operationId);
  assert.deepEqual(store.session(sessionId).accepts, [receipt.operationId]);

  // Ownership: exactly one writer slot with a persisted epoch.
  const slot = daemon.supervisor.get(sessionId);
  assert.ok(slot);
  assert.equal(slot.ownerEpoch, 1);

  await daemon.close();
});

test("dedup: replay returns the ORIGINAL receipt; changed payload is rejected", async () => {
  const { daemon, workspaceId } = startDaemon();
  const sessionId = await createSessionViaService(daemon.service, workspaceId);
  const input = {
    clientMutationId: "mut-dup",
    commandId: "cmd_dup",
    kind: "prompt",
    payload: { prompt: "same" },
    scope: { sessionId, workspaceId },
  };
  const first = daemon.service.submit(input, PRINCIPAL);
  const replay = daemon.service.submit(input, PRINCIPAL);
  assert.deepEqual(replay, first);

  assert.throws(
    () =>
      daemon.service.submit(
        { ...input, payload: { prompt: "different" } },
        PRINCIPAL
      ),
    (error: unknown) =>
      error instanceof OmoCommandError &&
      error.code === "duplicate_payload_mismatch"
  );
  await daemon.close();
});

test("crash window 1: admitted-but-never-driven op is driven after restart", async () => {
  const dataDir = makeDir();
  const store = new FakeSessionStore();
  store.hangDrives = true; // drive never settles: the daemon "dies" mid-drive

  const started1 = startDaemon({ closeGraceMs: 50, dataDir, store });
  const sessionId = await createSessionViaService(
    started1.daemon.service,
    started1.workspaceId
  );
  const receipt = started1.daemon.service.submit(
    {
      clientMutationId: "mut-hang",
      commandId: "cmd_hang",
      kind: "prompt",
      payload: { prompt: "work" },
      scope: { sessionId, workspaceId: started1.workspaceId },
    },
    PRINCIPAL
  );
  await waitFor(() => {
    const record = started1.daemon.service.getCommand("cmd_hang");
    return record?.state === "running" ? record : undefined;
  });
  // Simulated crash: close with a hung drive outstanding.
  const crashed = started1.daemon.service.getCommand("cmd_hang");
  await started1.daemon.close();
  assert.equal(crashed?.state, "running");

  // Restart over the SAME control database; the fake execution store still
  // holds the op open (its admission was durable).
  store.hangDrives = false;
  const started2 = startDaemon({ dataDir, store });
  const recovered = await waitFor(() => {
    const record = started2.daemon.service.getCommand("cmd_hang");
    return record?.state === "completed" ? record : undefined;
  });
  assert.equal(
    (recovered.result as { operationId: string }).operationId,
    receipt.operationId
  );
  // The SAME operation id was driven exactly once per runtime generation.
  assert.deepEqual(store.session(sessionId).accepts, [receipt.operationId]);
  await started2.daemon.close();
});

test("crash window 2: settled-but-unrecorded op completes from the result", async () => {
  const dataDir = makeDir();
  const rootDir = makeDir();
  const workspaceDir = join(rootDir, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  // Durable execution fact: op settled BEFORE the daemon crashed, but the
  // completion was never recorded in the inbox (reply-window crash, §5.4).
  const store = new FakeSessionStore();
  store.session("ses_seed").results.set("op_settled", {
    operationId: "op_settled",
    status: "completed",
  });
  let workspaceId: string;
  {
    const { db } = openDurableDatabase(join(dataDir, "control.sqlite"));
    ({ workspaceId } = WorkspaceRegistry.attach(db, [rootDir]).register({
      path: workspaceDir,
    }));
    const inbox = CommandInbox.attach(db);
    inbox.receive(
      {
        clientMutationId: "mut-settled",
        commandId: "cmd_settled",
        kind: "prompt",
        operationId: "op_settled",
        payload: { prompt: "work" },
        scope: { sessionId: "ses_seed", workspaceId },
      },
      PRINCIPAL
    );
    inbox.markAdmitted("cmd_settled", "op_settled");
    inbox.markRunning("cmd_settled");
    db.close();
  }

  const { daemon } = startDaemon({ dataDir, rootDir, store });
  const record = await waitFor(() => {
    const candidate = daemon.service.getCommand("cmd_settled");
    return candidate?.state === "completed" ? candidate : undefined;
  });
  assert.equal(
    (record.result as { operationId: string }).operationId,
    "op_settled"
  );
  // No second accept, no second execution (§5.6: 已完成且结果持久化的工具绝不再次执行).
  assert.deepEqual(store.session("ses_seed").accepts, []);
  assert.deepEqual(store.session("ses_seed").drives, []);
  await daemon.close();
});

test("crash window 3: queued-but-never-admitted op re-accepts the SAME id", async () => {
  const dataDir = makeDir();
  const rootDir = makeDir();
  const workspaceDir = join(rootDir, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const store = new FakeSessionStore();
  store.session("ses_queued"); // exists but has never seen the operation
  {
    const { db } = openDurableDatabase(join(dataDir, "control.sqlite"));
    const { workspaceId } = WorkspaceRegistry.attach(db, [rootDir]).register({
      path: workspaceDir,
    });
    const inbox = CommandInbox.attach(db);
    inbox.receive(
      {
        clientMutationId: "mut-queued",
        commandId: "cmd_queued",
        kind: "prompt",
        operationId: "op_queued",
        payload: { prompt: "work" },
        scope: { sessionId: "ses_queued", workspaceId },
      },
      PRINCIPAL
    );
    db.close();
  }

  const { daemon } = startDaemon({ dataDir, rootDir, store });
  const record = await waitFor(() => {
    const candidate = daemon.service.getCommand("cmd_queued");
    return candidate?.state === "completed" ? candidate : undefined;
  });
  assert.equal(record.operationId, "op_queued");
  assert.deepEqual(store.session("ses_queued").accepts, ["op_queued"]);
  await daemon.close();
});

test("single writer: a second daemon on the same data directory is refused", async () => {
  const { daemon, dataDir } = startDaemon();
  assert.throws(
    () =>
      openDaemon({
        dataDir,
        pairingCode: "code",
        runtime: new FakeRuntime(new FakeSessionStore()),
      }),
    (error: unknown) =>
      error instanceof OmoCommandError && error.code === "writer_conflict"
  );
  await daemon.close();
  // After a clean close the directory is acquirable again.
  const reopened = openDaemon({
    dataDir,
    pairingCode: "code",
    runtime: new FakeRuntime(new FakeSessionStore()),
  });
  await reopened.close();
});

test("stale lock takeover only after the holder PID is confirmed dead", async () => {
  const dataDir = makeDir();
  // Obtain a definitely-dead PID by running a child to completion.
  const deadPid = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", () => {
      if (child.pid === undefined) {
        reject(new Error("child had no pid"));
      } else {
        resolve(child.pid);
      }
    });
  });
  writeFileSync(
    join(dataDir, "daemon.lock"),
    `${JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString(), token: "stale" })}\n`
  );
  const daemon = openDaemon({
    dataDir,
    pairingCode: "code",
    runtime: new FakeRuntime(new FakeSessionStore()),
  });
  await daemon.close();
});

test("operation.abort cancels the in-flight run; the run's command ends cancelled", async () => {
  const { daemon, store, workspaceId } = startDaemon();
  store.hangDrives = true;
  const sessionId = await createSessionViaService(daemon.service, workspaceId);
  const prompt = daemon.service.submit(
    {
      clientMutationId: "mut-prompt",
      commandId: "cmd_abort_target",
      kind: "prompt",
      payload: { prompt: "long work" },
      scope: { sessionId, workspaceId },
    },
    PRINCIPAL
  );
  await waitFor(() => {
    const record = daemon.service.getCommand("cmd_abort_target");
    return record?.state === "running" ? record : undefined;
  });

  const abort = daemon.service.submit(
    {
      clientMutationId: "mut-abort",
      commandId: "cmd_abort",
      expectedOperationId: prompt.operationId,
      kind: "operation.abort",
      payload: { operationId: prompt.operationId },
      scope: { sessionId, workspaceId },
    },
    PRINCIPAL
  );
  assert.ok(abort);

  const abortRecord = await waitFor(() => {
    const record = daemon.service.getCommand("cmd_abort");
    return record?.state === "completed" ? record : undefined;
  });
  assert.equal((abortRecord.result as { aborted: boolean }).aborted, true);

  const target = await waitFor(() => {
    const record = daemon.service.getCommand("cmd_abort_target");
    return record?.state === "cancelled" ? record : undefined;
  });
  assert.equal((target.result as { status: string }).status, "aborted");

  // CAS mismatch is rejected rather than silently ignored (§6.3).
  assert.throws(
    () =>
      daemon.service.submit(
        {
          clientMutationId: "mut-abort-2",
          commandId: "cmd_abort_2",
          expectedOperationId: "op_other",
          kind: "operation.abort",
          payload: { operationId: "op_this" },
          scope: { sessionId, workspaceId },
        },
        PRINCIPAL
      ),
    (error: unknown) =>
      error instanceof OmoCommandError && error.code === "operation_mismatch"
  );
  await daemon.close();
});

test("unknown workspaces and cross-workspace sessions are rejected", async () => {
  const { daemon, rootDir, workspaceId } = startDaemon();
  const sessionId = await createSessionViaService(daemon.service, workspaceId);

  assert.throws(
    () =>
      daemon.service.submit(
        {
          clientMutationId: "m-nows",
          commandId: "cmd_noworkspace",
          kind: "prompt",
          payload: { prompt: "x" },
          scope: { sessionId, workspaceId: "wks_unregistered" },
        },
        PRINCIPAL
      ),
    (error: unknown) =>
      error instanceof OmoCommandError && error.code === "unknown_workspace"
  );

  const other = startDaemon();
  const foreignSession = await createSessionViaService(
    other.daemon.service,
    other.workspaceId
  );
  // A session this daemon never catalogued is invisible to its workspace:
  // the command passes submit validation but the runtime cannot open it.
  daemon.service.submit(
    {
      clientMutationId: "m-xws",
      commandId: "cmd_crossws",
      kind: "prompt",
      payload: { prompt: "x" },
      scope: { sessionId: foreignSession, workspaceId },
    },
    PRINCIPAL
  );
  const failedForeign = await waitFor(() => {
    const record = daemon.service.getCommand("cmd_crossws");
    return record?.state === "failed" ? record : undefined;
  });
  assert.equal(
    (failedForeign.error as { code: string }).code,
    "unknown_command"
  );
  // Cross-workspace WITHIN one daemon: catalogue coherence, not unknown id.
  const secondDir = join(rootDir, "ws-second");
  mkdirSync(secondDir, { recursive: true });
  const secondWorkspace = daemon.workspaces.register({
    name: "second",
    path: secondDir,
  });
  const otherSessionInThisDaemon = await createSessionViaService(
    daemon.service,
    secondWorkspace.workspaceId
  );
  assert.throws(
    () =>
      daemon.service.submit(
        {
          clientMutationId: "m-xws-2",
          commandId: "cmd_crossws_2",
          kind: "prompt",
          payload: { prompt: "x" },
          scope: { sessionId: otherSessionInThisDaemon, workspaceId },
        },
        PRINCIPAL
      ),
    (error: unknown) =>
      error instanceof OmoCommandError && error.code === "permission_denied"
  );
  await other.daemon.close();
  await daemon.close();
});

test("unsupported CAS preconditions and unknown kinds are rejected explicitly", async () => {
  const { daemon, workspaceId } = startDaemon();
  assert.throws(
    () =>
      daemon.service.submit(
        {
          clientMutationId: "m1",
          commandId: "c1",
          expectedRevision: "7",
          kind: "session.create",
          payload: {},
          scope: { workspaceId },
        },
        PRINCIPAL
      ),
    (error: unknown) =>
      error instanceof OmoCommandError &&
      error.code === "payload_schema_unsupported"
  );
  assert.throws(
    () =>
      daemon.service.submit(
        {
          clientMutationId: "m2",
          commandId: "c2",
          kind: "totally.unknown",
          payload: {},
          scope: { workspaceId },
        },
        PRINCIPAL
      ),
    (error: unknown) =>
      error instanceof OmoCommandError && error.code === "unknown_schema"
  );
  await daemon.close();
});

test("interactions: persist-first create and first-writer-wins answer", async () => {
  const { daemon, workspaceId } = startDaemon();
  const created = daemon.service.createInteraction({
    eligiblePrincipals: ["usr_test"],
    invocationId: "inv_1",
    request: { question: "proceed?" },
    schemaVersion: 1,
    scope: { sessionId: "ses_x", workspaceId },
  });
  assert.equal(created.status, "pending");
  assert.ok(created.interactionId.startsWith("int_"));

  const first = daemon.service.answerInteraction(
    created.interactionId,
    PRINCIPAL,
    { approved: true }
  );
  assert.equal(first.ok, true);
  const second = daemon.service.answerInteraction(
    created.interactionId,
    PRINCIPAL,
    { approved: false }
  );
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.code, "already_answered");
    assert.deepEqual(second.record?.answer, { approved: true });
  }
  const outsider = daemon.service.answerInteraction(
    created.interactionId,
    { deviceId: "dev_other", userId: "usr_other" },
    { approved: false }
  );
  assert.equal(outsider.ok, false);
  if (!outsider.ok) {
    // Already answered beats eligibility when both apply.
    assert.equal(outsider.code, "already_answered");
  }
  await daemon.close();
});
