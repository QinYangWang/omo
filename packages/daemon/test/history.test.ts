import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createFauxModels } from "@omo/agent-runtime/testing";
import { openDaemon } from "../src/daemon.ts";
import { createCoreDaemonRuntime } from "../src/runtime.ts";
import {
  FakeRuntime,
  FakeSessionStore,
  waitFor,
} from "./helpers/fake-runtime.ts";

/**
 * History pagination projection (plan §5.7, §6.4; works around the upstream
 * `watchSession()` gap §3.3.1 by reading through the owning worker): pages
 * use decimal-string cursors (§6.3) and are verified against BOTH the fake
 * runtime and the real CoreHarnessRuntime + faux provider.
 */

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p2-history-"));
  tempDirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const PRINCIPAL = { deviceId: "dev_hist", userId: "usr_hist" };

test("history: fake runtime paginates with decimal-string cursors", async () => {
  const dataDir = makeDir();
  const rootDir = makeDir();
  const workspaceDir = join(rootDir, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const daemon = openDaemon({
    dataDir,
    pairingCode: "code",
    runtime: new FakeRuntime(new FakeSessionStore()),
    workspaceRoots: [rootDir],
  });
  const { workspaceId } = daemon.workspaces.register({ path: workspaceDir });

  daemon.service.submit(
    {
      clientMutationId: "h-create",
      commandId: "cmd_h_create",
      kind: "session.create",
      payload: {},
      scope: { workspaceId },
    },
    PRINCIPAL
  );
  const created = await waitFor(() => {
    const record = daemon.service.getCommand("cmd_h_create");
    return record?.state === "completed" ? record : undefined;
  });
  const { sessionId } = created.result as { sessionId: string };

  // Two prompts → two user+assistant entry pairs in the fake transcript.
  for (const [index, mutation] of ["h-p1", "h-p2"].entries()) {
    daemon.service.submit(
      {
        clientMutationId: mutation,
        commandId: `cmd_${mutation}`,
        kind: "prompt",
        payload: { prompt: `q${index}` },
        scope: { sessionId, workspaceId },
      },
      PRINCIPAL
    );
    // Serialize the two runs so entry order is deterministic.
    // biome-ignore lint/performance/noAwaitInLoops: intentional ordering
    await waitFor(() => {
      const record = daemon.service.getCommand(`cmd_${mutation}`);
      return record?.state === "completed" ? record : undefined;
    });
  }

  const first = await daemon.service.readHistory(sessionId, { limit: 2 });
  assert.equal(first.entries.length, 2);
  assert.equal(first.entries[0].seq, 1);
  assert.equal(first.nextCursor, "2");

  const second = await daemon.service.readHistory(sessionId, {
    cursor: first.nextCursor as string,
    limit: 2,
  });
  assert.equal(second.entries.length, 2);
  assert.equal(second.entries[0].seq, 3);
  assert.equal(second.nextCursor, null);
  await daemon.close();
});

test("history: real harness transcript survives pagination + restart", async () => {
  const dataDir = makeDir();
  const rootDir = makeDir();
  const { faux, model, models } = createFauxModels();
  faux.setResponses([fauxAssistantMessage("page me")]);
  const workspaceDir = join(rootDir, "ws");
  mkdirSync(workspaceDir, { recursive: true });

  const daemon = openDaemon({
    dataDir,
    pairingCode: "code",
    runtime: createCoreDaemonRuntime({ dataDir, model, models }),
    workspaceRoots: [rootDir],
  });
  const { workspaceId } = daemon.workspaces.register({ path: workspaceDir });

  daemon.service.submit(
    {
      clientMutationId: "hr-create",
      commandId: "cmd_hr_create",
      kind: "session.create",
      payload: { name: "history" },
      scope: { workspaceId },
    },
    PRINCIPAL
  );
  const created = await waitFor(() => {
    const record = daemon.service.getCommand("cmd_hr_create");
    return record?.state === "completed" ? record : undefined;
  });
  const { sessionId } = created.result as { sessionId: string };

  daemon.service.submit(
    {
      clientMutationId: "hr-prompt",
      commandId: "cmd_hr_prompt",
      kind: "prompt",
      payload: { prompt: "give me history" },
      scope: { laneId: "main", sessionId, workspaceId },
    },
    PRINCIPAL
  );
  await waitFor(() => {
    const record = daemon.service.getCommand("cmd_hr_prompt");
    return record?.state === "completed" ? record : undefined;
  });

  const page = await daemon.service.readHistory(sessionId);
  assert.ok(page.entries.length >= 2, "user + assistant entries persisted");
  const userEntry = page.entries.find((entry) => {
    const body = entry.body as { role?: string; content?: unknown };
    return entry.type === "message" && body.role === "user";
  });
  assert.ok(userEntry, "user message entry present in the projection");
  const assistantEntry = page.entries.find((entry) => {
    const body = entry.body as { role?: string };
    return entry.type === "message" && body.role === "assistant";
  });
  assert.ok(assistantEntry, "assistant message entry present");

  // Restart: history is durable across daemon restarts (execution facts).
  await daemon.close();
  const reopened = openDaemon({
    dataDir,
    pairingCode: "code",
    runtime: createCoreDaemonRuntime({ dataDir, model, models }),
    workspaceRoots: [rootDir],
  });
  const replayed = await reopened.service.readHistory(sessionId);
  assert.equal(replayed.entries.length, page.entries.length);
  assert.deepEqual(
    replayed.entries.map((entry) => entry.id),
    page.entries.map((entry) => entry.id)
  );
  await reopened.close();
});
