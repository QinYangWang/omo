import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { openDaemon } from "../src/daemon.ts";
import { DaemonHttpServer } from "../src/http.ts";
import {
  FakeRuntime,
  FakeSessionStore,
  waitFor,
} from "./helpers/fake-runtime.ts";

/**
 * P2 收尾 daemon 面验证（plan §6.6, §5.8.3）：
 *  - prompt 附件：artifactIds → integrity-checked base64 images → runtime accept；
 *  - session.configure：模型/思考级别在串行链上于在途运行之后生效（下一运行边界）；
 *  - GET /v1/models 暴露 provider 目录。
 */

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p2-fin-"));
  tempDirs.push(dir);
  return dir;
};

const daemons: Array<{ close: () => Promise<void> }> = [];

after(async () => {
  for (const daemon of daemons) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential cleanup
    await daemon.close().catch(() => undefined);
  }
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const PRINCIPAL = { deviceId: "dev_fin", userId: "usr_fin" };

const start = (store?: FakeSessionStore) => {
  const rootDir = makeDir();
  const workspaceDir = join(rootDir, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const daemon = openDaemon({
    dataDir: makeDir(),
    pairingCode: "code",
    runtime: new FakeRuntime(store ?? new FakeSessionStore()),
    workspaceRoots: [rootDir],
  });
  daemons.push(daemon);
  const { workspaceId } = daemon.workspaces.register({ path: workspaceDir });
  return { daemon, workspaceId };
};

const createSession = async (
  daemon: ReturnType<typeof openDaemon>,
  workspaceId: string,
  mutation: string
): Promise<string> => {
  daemon.service.submit(
    {
      clientMutationId: mutation,
      commandId: `cmd_${mutation}`,
      kind: "session.create",
      payload: {},
      scope: { workspaceId },
    },
    PRINCIPAL
  );
  const record = await waitFor(() => {
    const candidate = daemon.service.getCommand(`cmd_${mutation}`);
    return candidate?.state === "completed" ? candidate : undefined;
  });
  const { sessionId } = record.result as { sessionId: string };
  return sessionId;
};

test("prompt with artifactIds resolves integrity-checked images at accept", async () => {
  const store = new FakeSessionStore();
  const { daemon, workspaceId } = start(store);
  const sessionId = await createSession(daemon, workspaceId, "fin-create");

  const bytes = Buffer.from("fake-png-bytes");
  const artifact = daemon.artifacts.put(bytes, { mime: "image/png" });

  daemon.service.submit(
    {
      clientMutationId: "fin-prompt-img",
      commandId: "cmd_fin_img",
      kind: "prompt",
      payload: { artifactIds: [artifact.artifactId], prompt: "look at this" },
      scope: { sessionId, workspaceId },
    },
    PRINCIPAL
  );
  await waitFor(() => {
    const record = daemon.service.getCommand("cmd_fin_img");
    return record?.state === "completed" ? record : undefined;
  });

  const accepted = store.session(sessionId).open.size === 0; // settled
  assert.equal(accepted, true);
  // Direct evidence: the accepted user entry carried the resolved image.
  const { entries } = store.session(sessionId);
  const userEntry = entries.find((entry) => entry.seq === 1);
  assert.equal(userEntry?.images?.length, 1);
  assert.equal(
    userEntry?.images?.[0].data,
    bytes.toString("base64"),
    "image bytes must reach the runtime accept path intact"
  );
  assert.equal(userEntry?.images?.[0].mimeType, "image/png");
  const record = daemon.service.getCommand("cmd_fin_img");
  assert.equal(record?.state, "completed");

  // Unknown artifact id fails loudly instead of being dropped.
  daemon.service.submit(
    {
      clientMutationId: "fin-prompt-bad",
      commandId: "cmd_fin_bad",
      kind: "prompt",
      payload: { artifactIds: ["art_missing"], prompt: "look" },
      scope: { sessionId, workspaceId },
    },
    PRINCIPAL
  );
  const failed = await waitFor(() => {
    const candidate = daemon.service.getCommand("cmd_fin_bad");
    return candidate?.state === "failed" ? candidate : undefined;
  });
  assert.equal((failed.error as { code: string }).code, "unknown_command");
});

test("session.configure applies on the next-run boundary (serialized after in-flight)", async () => {
  const store = new FakeSessionStore();
  store.hangDrives = true; // hold the prompt in-flight
  const { daemon, workspaceId } = start(store);
  const sessionId = await createSession(daemon, workspaceId, "fin-create2");

  daemon.service.submit(
    {
      clientMutationId: "fin-prompt-hold",
      commandId: "cmd_fin_hold",
      kind: "prompt",
      payload: { prompt: "hold me" },
      scope: { sessionId, workspaceId },
    },
    PRINCIPAL
  );
  await waitFor(() => {
    const record = daemon.service.getCommand("cmd_fin_hold");
    return record?.state === "running" ? record : undefined;
  });

  daemon.service.submit(
    {
      clientMutationId: "fin-config",
      commandId: "cmd_fin_config",
      kind: "session.configure",
      payload: {
        model: { modelId: "faux-2", provider: "faux" },
        thinkingLevel: "high",
      },
      scope: { sessionId, workspaceId },
    },
    PRINCIPAL
  );

  // The configure command must NOT run while the prompt drive is in flight.
  await new Promise((resolve) => {
    setTimeout(resolve, 150);
  });
  assert.equal(store.session(sessionId).configCalls.length, 0);

  // Unblock the drive; configure then lands and completes.
  store.hangDrives = false;
  for (const [, proc] of store.session(sessionId).pendingDrives) {
    proc({ operationId: "op", status: "completed" });
  }
  await waitFor(() => {
    const record = daemon.service.getCommand("cmd_fin_config");
    return record?.state === "completed" ? record : undefined;
  });
  assert.deepEqual(store.session(sessionId).configCalls, [
    { model: { modelId: "faux-2", provider: "faux" } },
    { thinkingLevel: "high" },
  ]);
});

test("GET /v1/models lists the provider catalog", async () => {
  const { daemon } = start();
  const http = new DaemonHttpServer(daemon);
  const { port } = await http.listen(0);
  const pairing = await fetch(`http://127.0.0.1:${port}/v1/pairing`, {
    body: JSON.stringify({ code: "code" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const { token } = (await pairing.json()) as { token: string };
  const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    models: { modelId: string; provider: string }[];
  };
  assert.deepEqual(body.models, [
    { modelId: "faux-1", name: "Faux One", provider: "faux" },
  ]);
  await http.close();
});
