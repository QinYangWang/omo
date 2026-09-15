import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createFauxModels } from "@omo/agent-runtime/testing";
import { CommandInbox } from "@omo/control-plane/inbox";
import { openDurableDatabase } from "@omo/storage/durable-database";
import { openDaemon } from "../src/daemon.ts";
import { createCoreDaemonRuntime } from "../src/runtime.ts";
import { WorkspaceRegistry } from "../src/workspaces.ts";
import { waitFor } from "./helpers/fake-runtime.ts";

/**
 * P1 end-to-end assembly against the REAL upstream-backed runtime (plan §13
 * P1 gate): session.create + prompt commands flow through the durable inbox
 * into an actual AgentHarness on WAL + FULL storage; a restart recovers the
 * admitted-but-not-driven window exactly as the P0 harness-recovery
 * experiment established (docs/v2-upstream-verification.md §1).
 */

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p1-e2e-"));
  tempDirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const PRINCIPAL = { deviceId: "dev_e2e", userId: "usr_e2e" };

interface E2eContext {
  daemon: ReturnType<typeof openDaemon>;
  workspaceId: string;
}

const openE2eDaemon = (
  dataDir: string,
  rootDir: string,
  models: ReturnType<typeof createFauxModels>["models"],
  model: ReturnType<typeof createFauxModels>["model"]
): E2eContext => {
  const daemon = openDaemon({
    dataDir,
    pairingCode: "code",
    runtime: createCoreDaemonRuntime({ dataDir, model, models }),
    workspaceRoots: [rootDir],
  });
  const workspaceDir = join(rootDir, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const workspace = daemon.workspaces.register({ path: workspaceDir });
  return { daemon, workspaceId: workspace.workspaceId };
};

test("e2e: session.create + prompt over the real harness, durable across restart", async () => {
  const dataDir = makeDir();
  const rootDir = makeDir();
  const { faux, model, models } = createFauxModels();
  faux.setResponses([fauxAssistantMessage("p1 e2e reply")]);

  const { daemon, workspaceId } = openE2eDaemon(
    dataDir,
    rootDir,
    models,
    model
  );

  daemon.service.submit(
    {
      clientMutationId: "mut-create",
      commandId: "cmd_create",
      kind: "session.create",
      payload: { name: "e2e session" },
      scope: { workspaceId },
    },
    PRINCIPAL
  );
  const created = await waitFor(() => {
    const record = daemon.service.getCommand("cmd_create");
    return record?.state === "completed" ? record : undefined;
  });
  const { sessionId } = created.result as { sessionId: string };
  assert.ok(sessionId.length > 0);
  assert.equal(created.operationId, sessionId);
  // The session is catalogued under its workspace (§5.1 product identity).
  assert.equal(daemon.catalog.get(sessionId)?.workspaceId, workspaceId);

  const prompt = daemon.service.submit(
    {
      clientMutationId: "mut-prompt",
      commandId: "cmd_prompt",
      kind: "prompt",
      payload: { prompt: "say something" },
      scope: { laneId: "main", sessionId, workspaceId },
    },
    PRINCIPAL
  );
  const done = await waitFor(() => {
    const record = daemon.service.getCommand("cmd_prompt");
    return record?.state === "completed" ? record : undefined;
  });
  assert.equal(
    (done.result as { status: string }).status,
    "completed",
    "real harness must settle the fixed omo operation id"
  );
  assert.equal(done.operationId, prompt.operationId);

  // Restart: receipts and results remain queryable; identity is stable.
  const { serverId } = daemon.identity;
  await daemon.close();

  const { daemon: daemon2 } = openE2eDaemon(dataDir, rootDir, models, model);
  assert.equal(daemon2.identity.serverId, serverId);
  assert.equal(
    daemon2.service.getCommand("cmd_prompt")?.state,
    "completed",
    "completed receipt must survive a daemon restart (§5.8)"
  );
  assert.equal(daemon2.service.getCommand("cmd_create")?.state, "completed");
  // Workspace registration survived the restart without duplication.
  assert.equal(daemon2.workspaces.list().length, 1);
  assert.equal(daemon2.catalog.get(sessionId)?.workspaceId, workspaceId);
  await daemon2.close();
});

test("e2e: restart reconciles an admitted-but-not-driven REAL operation", async () => {
  const dataDir = makeDir();
  const rootDir = makeDir();
  const { faux, model, models } = createFauxModels();
  faux.setResponses([fauxAssistantMessage("recovered after crash")]);

  // Phase 1: a runtime admits op_PENDING to durable execution storage, then
  // "dies" before any drive (same window as experiments/p0/harness-recovery).
  const runtime1 = createCoreDaemonRuntime({ dataDir, model, models });
  const crashed = await runtime1.createSession("recovery target");
  const { sessionId } = crashed;
  const admission = await crashed.accept({
    kind: "prompt",
    operationId: "op_PENDING",
    prompt: "unfinished work",
  });
  assert.equal(admission.ok, true);
  await crashed.close();
  await runtime1.close();

  // The control-plane crash left the command admitted-but-uncompleted.
  let workspaceId: string;
  {
    const { db } = openDurableDatabase(join(dataDir, "control.sqlite"));
    const workspaceDir = join(rootDir, "ws");
    mkdirSync(workspaceDir, { recursive: true });
    ({ workspaceId } = WorkspaceRegistry.attach(db, [rootDir]).register({
      path: workspaceDir,
    }));
    const inbox = CommandInbox.attach(db);
    inbox.receive(
      {
        clientMutationId: "mut-pending",
        commandId: "cmd_pending",
        kind: "prompt",
        operationId: "op_PENDING",
        payload: { prompt: "unfinished work" },
        scope: { laneId: "main", sessionId, workspaceId },
      },
      PRINCIPAL
    );
    inbox.markAdmitted("cmd_pending", "op_PENDING");
    db.close();
  }

  // Phase 2: daemon restart must reconcile WITHOUT a duplicate accept.
  const { daemon } = openE2eDaemon(dataDir, rootDir, models, model);
  const recovered = await waitFor(() => {
    const record = daemon.service.getCommand("cmd_pending");
    return record?.state === "completed" ? record : undefined;
  }, 15_000);
  assert.equal((recovered.result as { status: string }).status, "completed");
  assert.equal(recovered.operationId, "op_PENDING");
  await daemon.close();
});

test("e2e: prompt with an artifact image through the REAL harness", async () => {
  const dataDir = makeDir();
  const rootDir = makeDir();
  const { faux, model, models } = createFauxModels();
  faux.setResponses([fauxAssistantMessage("saw the image")]);

  const { daemon, workspaceId } = openE2eDaemon(
    dataDir,
    rootDir,
    models,
    model
  );
  daemon.service.submit(
    {
      clientMutationId: "mut-create",
      commandId: "cmd_create_img",
      kind: "session.create",
      payload: { name: "image session" },
      scope: { workspaceId },
    },
    PRINCIPAL
  );
  const created = await waitFor(() => {
    const record = daemon.service.getCommand("cmd_create_img");
    return record?.state === "completed" ? record : undefined;
  });
  const { sessionId } = created.result as { sessionId: string };

  const artifact = daemon.artifacts.put(Buffer.from("png-bytes"), {
    mime: "image/png",
  });
  daemon.service.submit(
    {
      clientMutationId: "mut-prompt-img",
      commandId: "cmd_prompt_img",
      kind: "prompt",
      payload: { artifactIds: [artifact.artifactId], prompt: "what is this?" },
      scope: { laneId: "main", sessionId, workspaceId },
    },
    PRINCIPAL
  );
  const done = await waitFor(() => {
    const record = daemon.service.getCommand("cmd_prompt_img");
    return record?.state === "completed" ? record : undefined;
  }, 15_000);
  assert.equal((done.result as { status: string }).status, "completed");

  // The user entry in the durable transcript carries the image content block.
  const history = await daemon.service.readHistory(sessionId);
  const userEntry = history.entries.find((entry) => {
    const body = entry.body as { role?: string };
    return entry.type === "message" && body.role === "user";
  });
  assert.ok(userEntry);
  const { content } = userEntry.body as { content?: { type?: string }[] };
  assert.ok(
    content?.some((block) => block.type === "image"),
    "transcript must carry the image block, proving artifact→accept wiring"
  );
  await daemon.close();
});
