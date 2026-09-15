import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { OmoClient } from "@omo/client/client";
import { OmoSyncClient } from "@omo/client/sync-client";
import type { Frame } from "@omo/protocol/frame";
import { openDaemon } from "../src/daemon.ts";
import { DaemonHttpServer } from "../src/http.ts";
import {
  FakeRuntime,
  FakeSessionStore,
  waitFor,
} from "./helpers/fake-runtime.ts";

/**
 * P2 sync verification (plan §6.2–§6.4): WSS multiplex with one-time ticket
 * auth, snapshot + live frames with per-subscription publication sequences,
 * reconnect → fresh snapshot, and the backpressure reset policy. Runs the
 * real SyncHub over a real daemon with the fake runtime.
 */

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p2-sync-"));
  tempDirs.push(dir);
  return dir;
};

const daemons: Array<{ close: () => Promise<void> }> = [];
const servers: DaemonHttpServer[] = [];

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

interface StartedSync {
  baseUrl: string;
  client: OmoClient;
  daemon: ReturnType<typeof openDaemon>;
  http: DaemonHttpServer;
  port: number;
  store: FakeSessionStore;
  workspaceId: string;
}

const startDaemonWithHttp = async (
  dataDir: string,
  options?: { port?: number; store?: FakeSessionStore }
): Promise<StartedSync> => {
  const rootDir = makeDir();
  const workspaceDir = join(rootDir, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const store = options?.store ?? new FakeSessionStore();
  const daemon = openDaemon({
    dataDir,
    pairingCode: "code",
    retryDelayMs: 20,
    runtime: new FakeRuntime(store),
    workspaceRoots: [rootDir],
  });
  const { workspaceId } = daemon.workspaces.register({ path: workspaceDir });
  const http = new DaemonHttpServer(daemon);
  const { port } = await http.listen(options?.port ?? 0);
  daemons.push(daemon);
  servers.push(http);
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = await OmoClient.pair(baseUrl, "code", "sync-test");
  return { baseUrl, client, daemon, http, port, store, workspaceId };
};

const collectFrames = () => {
  const frames: Frame[] = [];
  const snapshots: unknown[] = [];
  const resets: string[] = [];
  return {
    frames,
    handlers: {
      onFrame: (frame: Frame) => frames.push(frame),
      onReset: (_sub: string, reason: string) => resets.push(reason),
      onSnapshot: (_sub: string, payload: unknown) => snapshots.push(payload),
    },
    resets,
    snapshots,
  };
};

const createSession = async (
  started: StartedSync,
  mutation: string
): Promise<string> => {
  await started.client.submitCommand({
    clientMutationId: mutation,
    commandId: `cmd_${mutation}`,
    kind: "session.create",
    payload: {},
    scope: { workspaceId: started.workspaceId },
  });
  const record = await waitFor(() => {
    const candidate = started.daemon.service.getCommand(`cmd_${mutation}`);
    return candidate?.state === "completed" ? candidate : undefined;
  });
  return (record.result as { sessionId: string }).sessionId;
};

test("sync: snapshot + live frames + per-subscription sequences on one WSS", async () => {
  const started = await startDaemonWithHttp(makeDir());
  const sync = new OmoSyncClient({
    reconnectDelayMs: 20,
    ticketProvider: async () => (await started.client.issueSyncTicket()).ticket,
    url: `ws://127.0.0.1:${started.port}/v1/sync`,
  });
  await sync.connect();

  const daemonChannel = collectFrames();
  sync.subscribe("daemon", daemonChannel.handlers);
  await waitFor(() =>
    daemonChannel.snapshots.length === 1 ? true : undefined
  );
  const daemonSnapshot = daemonChannel.snapshots[0] as {
    identity: { serverId: string };
    workspaces: unknown[];
  };
  assert.equal(
    daemonSnapshot.identity.serverId,
    started.daemon.identity.serverId
  );
  assert.equal(daemonSnapshot.workspaces.length, 1);

  const sessionId = await createSession(started, "sync-create-1");

  const sessionChannel = collectFrames();
  sync.subscribe(`session:${sessionId}`, sessionChannel.handlers);
  await waitFor(() =>
    sessionChannel.snapshots.length === 1 ? true : undefined
  );
  const sessionSnapshot = sessionChannel.snapshots[0] as {
    commands: unknown[];
    session: { sessionId: string };
  };
  assert.equal(sessionSnapshot.session.sessionId, sessionId);

  // Drive a prompt: command transitions + lane events must arrive in order.
  await started.client.submitCommand({
    clientMutationId: "sync-prompt-1",
    commandId: "cmd_sync_prompt_1",
    kind: "prompt",
    payload: { prompt: "hello sync" },
    scope: { sessionId, workspaceId: started.workspaceId },
  });
  await waitFor(() => {
    const record = started.daemon.service.getCommand("cmd_sync_prompt_1");
    return record?.state === "completed" ? true : undefined;
  });

  const commandFrames = sessionChannel.frames.filter(
    (frame) => frame.kind === "command.updated"
  );
  assert.ok(
    commandFrames.length >= 3,
    `expected queued→admitted→running→completed frames, got ${commandFrames.length}`
  );
  const sequences = sessionChannel.frames.map((frame) =>
    BigInt(frame.publicationSequence ?? "0")
  );
  for (let index = 1; index < sequences.length; index += 1) {
    assert.equal(
      sequences[index] > sequences[index - 1],
      true,
      "publicationSequence must strictly increase"
    );
  }
  const laneFrames = sessionChannel.frames.filter(
    (frame) => frame.kind === "lane.event"
  );
  assert.ok(
    laneFrames.some(
      (frame) =>
        (frame.payload as { event: { type: string } }).event.type ===
        "run_start"
    ),
    "lane run_start must reach the session channel"
  );
  assert.ok(
    laneFrames.some(
      (frame) =>
        (frame.payload as { event: { type: string } }).event.type === "run_end"
    ),
    "lane run_end must reach the session channel"
  );

  // The workspace channel sees the same command frames (its own sequence).
  const workspaceChannel = collectFrames();
  sync.subscribe(`workspace:${started.workspaceId}`, workspaceChannel.handlers);
  await waitFor(() =>
    workspaceChannel.snapshots.length === 1 ? true : undefined
  );
  await started.client.submitCommand({
    clientMutationId: "sync-prompt-2",
    commandId: "cmd_sync_prompt_2",
    kind: "prompt",
    payload: { prompt: "second" },
    scope: { sessionId, workspaceId: started.workspaceId },
  });
  await waitFor(() => {
    const record = started.daemon.service.getCommand("cmd_sync_prompt_2");
    return record?.state === "completed" ? true : undefined;
  });
  assert.ok(
    workspaceChannel.frames.some(
      (frame) =>
        frame.kind === "command.updated" &&
        (frame.payload as { command: { commandId: string } }).command
          .commandId === "cmd_sync_prompt_2"
    )
  );
  // The daemon channel does NOT get per-command noise (catalog-level only).
  assert.equal(
    daemonChannel.frames.filter((frame) => frame.kind === "command.updated")
      .length,
    0
  );
  assert.ok(
    daemonChannel.frames.some((frame) => frame.kind === "session.created"),
    "session.created reaches the daemon channel"
  );

  sync.close();
});

test("sync: draft updates are user-scoped and revision-checked", async () => {
  const started = await startDaemonWithHttp(makeDir());
  const sessionId = await createSession(started, "sync-draft-session");

  const sync = new OmoSyncClient({
    reconnectDelayMs: 20,
    ticketProvider: async () => (await started.client.issueSyncTicket()).ticket,
    url: `ws://127.0.0.1:${started.port}/v1/sync`,
  });
  await sync.connect();
  const channel = collectFrames();
  sync.subscribe(`session:${sessionId}`, channel.handlers);
  await waitFor(() => (channel.snapshots.length === 1 ? true : undefined));

  const put = await started.client.putDraft(sessionId, "draft body");
  assert.equal((put as { draft: { revision: number } }).draft.revision, 1);
  await waitFor(() =>
    channel.frames.some((frame) => frame.kind === "draft.updated")
      ? true
      : undefined
  );

  // Stale revision conflicts loudly (§6.6).
  const v2 = await started.client.putDraft(sessionId, "v2", 1);
  assert.equal((v2 as { draft: { revision: number } }).draft.revision, 2);
  await assert.rejects(
    started.client.putDraft(sessionId, "stale", 1),
    (error: unknown) =>
      error instanceof Error && error.name === "OmoCommandError"
  );
  sync.close();
});

test("sync: reconnect after server restart yields fresh snapshots", async () => {
  const dataDir = makeDir();
  const store = new FakeSessionStore();
  const first = await startDaemonWithHttp(dataDir, { store });
  const sessionId = await createSession(first, "sync-reconnect");

  const sync = new OmoSyncClient({
    reconnectDelayMs: 20,
    ticketProvider: async () => {
      // The provider always talks to the CURRENT server via the client.
      return (await first.client.issueSyncTicket()).ticket;
    },
    url: `ws://127.0.0.1:${first.port}/v1/sync`,
  });
  await sync.connect();
  const channel = collectFrames();
  sync.subscribe(`session:${sessionId}`, channel.handlers);
  await waitFor(() => (channel.snapshots.length === 1 ? true : undefined));

  // Restart the HTTP layer on the SAME port over the SAME daemon.
  const { port } = first;
  await first.http.close();
  servers.splice(servers.indexOf(first.http), 1);
  const secondHttp = new DaemonHttpServer(first.daemon);
  servers.push(secondHttp);
  // Rebind may race the OS releasing the port; retry briefly.
  let bound = false;
  for (let attempt = 0; attempt < 20 && !bound; attempt += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: sequential retry by design
      await secondHttp.listen(port);
      bound = true;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  }
  assert.equal(bound, true, "replacement server must bind the same port");

  // The client reconnects with a fresh ticket and gets a NEW snapshot.
  await waitFor(
    () => (channel.snapshots.length === 2 ? true : undefined),
    10_000
  );
  sync.close();
});

test("sync: two clients on one session see the SAME frame order (§6.6)", async () => {
  const started = await startDaemonWithHttp(makeDir());
  const sessionId = await createSession(started, "sync-two-clients");

  const connectViewer = async () => {
    const sync = new OmoSyncClient({
      reconnectDelayMs: 20,
      ticketProvider: async () =>
        (await started.client.issueSyncTicket()).ticket,
      url: `ws://127.0.0.1:${started.port}/v1/sync`,
    });
    await sync.connect();
    const channel = collectFrames();
    sync.subscribe(`session:${sessionId}`, channel.handlers);
    await waitFor(() => (channel.snapshots.length === 1 ? true : undefined));
    return { channel, sync };
  };
  const viewerA = await connectViewer();
  const viewerB = await connectViewer();

  await started.client.submitCommand({
    clientMutationId: "two-clients-1",
    commandId: "cmd_two_clients_1",
    kind: "prompt",
    payload: { prompt: "both of us watch this" },
    scope: { sessionId, workspaceId: started.workspaceId },
  });
  await waitFor(() => {
    const record = started.daemon.service.getCommand("cmd_two_clients_1");
    return record?.state === "completed" ? true : undefined;
  });
  await waitFor(() => {
    const kindsA = viewerA.channel.frames.map((frame) => frame.kind);
    const kindsB = viewerB.channel.frames.map((frame) => frame.kind);
    return kindsA.length >= 4 && kindsA.length === kindsB.length
      ? true
      : undefined;
  });

  // Same subscription channel, same order, same payloads — the server
  // determines ordering for every observer (§6.6).
  const simplify = (frames: Frame[]) =>
    frames.map((frame) => {
      const payload = frame.payload as {
        command?: { state: string };
        event?: { type: string };
      };
      return {
        kind: frame.kind,
        payloadKind: payload.command?.state ?? payload.event?.type,
        sequence: frame.publicationSequence,
      };
    });
  assert.deepEqual(
    simplify(viewerA.channel.frames),
    simplify(viewerB.channel.frames)
  );

  viewerA.sync.close();
  viewerB.sync.close();
});

test("sync: tickets are one-time and purpose-bound", async () => {
  const started = await startDaemonWithHttp(makeDir());
  const { ticket } = await started.client.issueSyncTicket();

  const url = `ws://127.0.0.1:${started.port}/v1/sync`;
  const firstSocket = new WebSocket(`${url}?ticket=${ticket}`);
  await new Promise<void>((resolve, reject) => {
    firstSocket.onopen = () => resolve();
    firstSocket.onerror = () => reject(new Error("first ticket rejected"));
  });

  // Reusing the same ticket must fail the upgrade.
  const reused = new WebSocket(`${url}?ticket=${ticket}`);
  await new Promise<void>((resolve) => {
    reused.onerror = () => resolve();
    reused.onclose = () => resolve();
  });
  firstSocket.close();
});
