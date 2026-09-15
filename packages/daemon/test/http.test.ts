import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
 * P1 network entry verification (plan §6.2, §10.1, §13 P1): pairing, device
 * revocation, durable 202 receipts over HTTP, dedup replay across a daemon
 * restart (reply-window crash from the client's perspective) and explicit
 * rejection of unknown / unauthenticated control traffic.
 */

const tempDirs: string[] = [];
const servers: DaemonHttpServer[] = [];
const daemons: Array<{ close: () => Promise<void> }> = [];

const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p1-http-"));
  tempDirs.push(dir);
  return dir;
};

after(async () => {
  for (const server of servers) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential cleanup
    await server.close().catch(() => undefined);
  }
  for (const daemon of daemons) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential cleanup
    await daemon.close().catch(() => undefined);
  }
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const PAIRING_CODE = "test-pairing-code";

interface StartedDaemon {
  baseUrl: string;
  daemon: ReturnType<typeof openDaemon>;
  http: DaemonHttpServer;
  workspaceId: string;
}

const startDaemon = async (
  dataDir: string,
  options?: { store?: FakeSessionStore }
): Promise<StartedDaemon> => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "omo-p1-http-ws-"));
  tempDirs.push(workspaceDir);
  const daemon = openDaemon({
    dataDir,
    pairingCode: PAIRING_CODE,
    retryDelayMs: 20,
    runtime: new FakeRuntime(options?.store ?? new FakeSessionStore()),
    workspaceRoots: [workspaceDir],
  });
  const { workspaceId } = daemon.workspaces.register({ path: workspaceDir });
  const http = new DaemonHttpServer(daemon);
  const { port } = await http.listen(0);
  daemons.push(daemon);
  servers.push(http);
  return { baseUrl: `http://127.0.0.1:${port}`, daemon, http, workspaceId };
};

const api = async (
  baseUrl: string,
  method: string,
  path: string,
  options?: { body?: unknown; token?: string }
): Promise<{ status: number; json: Record<string, never> }> => {
  const response = await fetch(`${baseUrl}${path}`, {
    body:
      options?.body === undefined ? undefined : JSON.stringify(options.body),
    headers: {
      ...(options?.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(options?.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    method,
  });
  return {
    json: (await response.json()) as Record<string, never>,
    status: response.status,
  };
};

const pair = async (
  baseUrl: string,
  code = PAIRING_CODE
): Promise<{ deviceId: string; token: string }> => {
  const response = await api(baseUrl, "POST", "/v1/pairing", {
    body: { code, name: "test device" },
  });
  assert.equal(response.status, 201);
  return response.json as unknown as { deviceId: string; token: string };
};

const createSessionOverHttp = async (
  baseUrl: string,
  token: string,
  daemon: StartedDaemon["daemon"],
  workspaceId: string
): Promise<string> => {
  const submitted = await api(baseUrl, "POST", "/v1/commands", {
    body: {
      clientMutationId: `create-${Math.random()}`,
      commandId: `cmd_http_create_${Math.random()}`,
      kind: "session.create",
      payload: {},
      scope: { workspaceId },
    },
    token,
  });
  assert.equal(submitted.status, 202);
  const { commandId } = (
    submitted.json as unknown as { receipt: { commandId: string } }
  ).receipt;
  const record = await waitFor(() => {
    const candidate = daemon.service.getCommand(commandId);
    return candidate?.state === "completed" ? candidate : undefined;
  });
  return (record.result as { sessionId: string }).sessionId;
};

test("hello is public; everything else requires a device credential", async () => {
  const { baseUrl } = await startDaemon(makeDir());
  const hello = await api(baseUrl, "GET", "/v1/hello");
  assert.equal(hello.status, 200);
  const { identity } = hello.json as unknown as {
    identity: { serverId: string; protocolVersion: number };
  };
  assert.ok(identity.serverId.startsWith("srv_"));
  assert.equal(identity.protocolVersion, 0);

  const denied = await api(baseUrl, "POST", "/v1/commands", { body: {} });
  assert.equal(denied.status, 401);
  assert.equal(
    (denied.json as unknown as { error: { code: string } }).error.code,
    "unauthenticated"
  );

  const badPairing = await api(baseUrl, "POST", "/v1/pairing", {
    body: { code: "wrong" },
  });
  assert.equal(badPairing.status, 401);
});

test("command submit → 202 durable receipt → query; replay dedups over HTTP", async () => {
  const started = await startDaemon(makeDir());
  const { token } = await pair(started.baseUrl);
  const sessionId = await createSessionOverHttp(
    started.baseUrl,
    token,
    started.daemon,
    started.workspaceId
  );

  const body = {
    clientMutationId: "mut-http-1",
    commandId: "cmd_http_1",
    kind: "prompt",
    payload: { prompt: "hello over http" },
    scope: { sessionId, workspaceId: started.workspaceId },
  };
  const submitted = await api(started.baseUrl, "POST", "/v1/commands", {
    body,
    token,
  });
  assert.equal(submitted.status, 202);
  const { receipt } = submitted.json as unknown as {
    receipt: {
      commandId: string;
      inboxSeq: string;
      receivedAt: string;
      state: string;
    };
  };
  assert.equal(receipt.state, "queued");

  // Idempotent replay: same mutation id + payload → the SAME command identity
  // (state may have legitimately advanced between the two calls).
  const replayed = await api(started.baseUrl, "POST", "/v1/commands", {
    body,
    token,
  });
  assert.equal(replayed.status, 202);
  const replayReceipt = (
    replayed.json as unknown as {
      receipt: {
        commandId: string;
        inboxSeq: string;
        operationId?: string;
        receivedAt: string;
      };
    }
  ).receipt;
  assert.equal(replayReceipt.commandId, receipt.commandId);
  assert.equal(replayReceipt.inboxSeq, receipt.inboxSeq);
  assert.equal(replayReceipt.receivedAt, receipt.receivedAt);

  // Same mutation id with a different payload is rejected with 409.
  const mismatched = await api(started.baseUrl, "POST", "/v1/commands", {
    body: { ...body, payload: { prompt: "changed" } },
    token,
  });
  assert.equal(mismatched.status, 409);
  assert.equal(
    (mismatched.json as unknown as { error: { code: string } }).error.code,
    "duplicate_payload_mismatch"
  );

  const record = await waitFor(() => {
    const candidate = started.daemon.service.getCommand("cmd_http_1");
    return candidate?.state === "completed" ? candidate : undefined;
  });
  assert.ok(record.operationId);

  const queried = await api(
    started.baseUrl,
    "GET",
    `/v1/commands/${record.commandId}`,
    { token }
  );
  assert.equal(queried.status, 200);

  const missing = await api(started.baseUrl, "GET", "/v1/commands/cmd_nope", {
    token,
  });
  assert.equal(missing.status, 404);
});

test("malformed and unknown control traffic is rejected explicitly", async () => {
  const { baseUrl, workspaceId } = await startDaemon(makeDir());
  const { token } = await pair(baseUrl);

  const raw = await fetch(`${baseUrl}/v1/commands`, {
    body: "{not json",
    headers: { authorization: `Bearer ${token}` },
    method: "POST",
  });
  assert.equal(raw.status, 400);

  const unknownKind = await api(baseUrl, "POST", "/v1/commands", {
    body: {
      clientMutationId: "m",
      commandId: "c",
      kind: "not.a.kind",
      payload: {},
      scope: { workspaceId },
    },
    token,
  });
  assert.equal(unknownKind.status, 400);
  assert.equal(
    (unknownKind.json as unknown as { error: { code: string } }).error.code,
    "unknown_schema"
  );
});

test("device revocation cuts off access immediately", async () => {
  const { baseUrl } = await startDaemon(makeDir());
  const { deviceId, token } = await pair(baseUrl);
  const revoked = await api(baseUrl, "POST", `/v1/devices/${deviceId}/revoke`, {
    token,
  });
  assert.equal(revoked.status, 200);

  const afterRevoke = await api(baseUrl, "GET", "/v1/hello");
  assert.equal(afterRevoke.status, 200); // hello stays public
  const denied = await api(baseUrl, "GET", "/v1/devices", { token });
  assert.equal(denied.status, 401);
});

test("interactions over HTTP: create, single answer, 409 for the loser", async () => {
  const { baseUrl, daemon, workspaceId } = await startDaemon(makeDir());
  const { token } = await pair(baseUrl);
  const { userId } = daemon.identity;

  const created = await api(baseUrl, "POST", "/v1/interactions", {
    body: {
      eligiblePrincipals: [userId],
      invocationId: "inv_http_1",
      request: { question: "proceed?" },
      schemaVersion: 1,
      scope: { sessionId: "ses_http", workspaceId },
    },
    token,
  });
  assert.equal(created.status, 201);
  const { interactionId } = (
    created.json as unknown as { interaction: { interactionId: string } }
  ).interaction;

  const answer = await api(
    baseUrl,
    "POST",
    `/v1/interactions/${interactionId}/answer`,
    { body: { answer: { approved: true } }, token }
  );
  assert.equal(answer.status, 200);

  const loser = await api(
    baseUrl,
    "POST",
    `/v1/interactions/${interactionId}/answer`,
    { body: { answer: { approved: false } }, token }
  );
  assert.equal(loser.status, 409);
  assert.equal(
    (loser.json as unknown as { error: { code: string } }).error.code,
    "already_answered"
  );

  const pending = await api(baseUrl, "GET", "/v1/interactions", { token });
  assert.equal(
    (pending.json as unknown as { interactions: unknown[] }).interactions
      .length,
    0
  );
});

test("reply-window crash: retry after daemon restart returns the SAME receipt", async () => {
  const dataDir = makeDir();
  // The execution store is shared so the session survives the daemon crash.
  const store = new FakeSessionStore();
  const first = await startDaemon(dataDir, { store });
  const { token } = await pair(first.baseUrl);
  const sessionId = await createSessionOverHttp(
    first.baseUrl,
    token,
    first.daemon,
    first.workspaceId
  );

  const body = {
    clientMutationId: "mut-window",
    commandId: "cmd_window",
    kind: "prompt",
    payload: { prompt: "might lose the reply" },
    scope: { sessionId, workspaceId: first.workspaceId },
  };
  // Fire the command but abandon the response immediately: from the client's
  // perspective the receipt is UNKNOWN (§4.3 对账规则: 按原 command ID 查询/对账).
  const abandoned = fetch(`${first.baseUrl}/v1/commands`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  }).catch(() => undefined);
  await Promise.race([
    abandoned,
    new Promise((resolve) => {
      setTimeout(resolve, 30);
    }),
  ]);
  await first.http.close();
  await first.daemon.close();

  const second = await startDaemon(dataDir, { store });
  const retried = await api(second.baseUrl, "POST", "/v1/commands", {
    body,
    token,
  });
  assert.equal(retried.status, 202);
  const { receipt } = retried.json as unknown as {
    receipt: { commandId: string };
  };
  assert.equal(receipt.commandId, "cmd_window");

  const record = await waitFor(() => {
    const candidate = second.daemon.service.getCommand("cmd_window");
    return candidate?.state === "completed" ? candidate : undefined;
  });
  // Regardless of where the crash landed, exactly one durable row exists.
  const all = second.daemon.service.listCommands({
    sessionId,
    workspaceId: first.workspaceId,
  });
  assert.equal(
    all.filter((command) => command.commandId === "cmd_window").length,
    1
  );
  assert.ok(record);
});
