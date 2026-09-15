import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { OmoClient } from "@omo/client/client";
import type { OmoSyncClient } from "@omo/client/sync-client";
import type { Frame } from "@omo/protocol/frame";
import { openDaemon } from "../src/daemon.ts";
import { DaemonHttpServer } from "../src/http.ts";
import {
  FakeRuntime,
  FakeSessionStore,
  waitFor,
} from "./helpers/fake-runtime.ts";

/**
 * Terminal e2e over the real stack (plan §6.6, §8.4): terminal.create command
 * → durable record → WS terminal channel → control acquire → real PTY input
 * echo → ordered output frames → two-device control transfer → kill → exit
 * record; daemon restart marks leftovers orphaned.
 */

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p2-term-e2e-"));
  tempDirs.push(dir);
  return dir;
};

const daemons: Array<{ close: () => Promise<void> }> = [];
const servers: DaemonHttpServer[] = [];
const syncClients: OmoSyncClient[] = [];

after(async () => {
  for (const client of syncClients) {
    client.close();
  }
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

interface Started {
  baseUrl: string;
  daemon: ReturnType<typeof openDaemon>;
  http: DaemonHttpServer;
  port: number;
  workspaceId: string;
}

const start = async (dataDir?: string): Promise<Started> => {
  const rootDir = makeDir();
  const workspaceDir = join(rootDir, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const daemon = openDaemon({
    dataDir: dataDir ?? makeDir(),
    pairingCode: "code",
    retryDelayMs: 20,
    runtime: new FakeRuntime(new FakeSessionStore()),
    workspaceRoots: [rootDir],
  });
  daemons.push(daemon);
  const { workspaceId } = daemon.workspaces.register({ path: workspaceDir });
  const http = new DaemonHttpServer(daemon);
  const { port } = await http.listen(0);
  servers.push(http);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    daemon,
    http,
    port,
    workspaceId,
  };
};

const connectSync = async (
  client: OmoClient,
  onError?: (error: { code: string; message: string }) => void
): Promise<OmoSyncClient> => {
  const sync = await client.createSyncClient({ onError, reconnectDelayMs: 50 });
  await sync.connect();
  syncClients.push(sync);
  return sync;
};

interface TerminalView {
  frames: Frame[];
  snapshot: () => unknown;
}

const collectTerminal = (
  sync: OmoSyncClient,
  terminalId: string
): TerminalView => {
  const frames: Frame[] = [];
  let snapshot: unknown;
  sync.subscribe(`terminal:${terminalId}`, {
    onFrame: (frame) => frames.push(frame),
    onSnapshot: (_id, payload) => {
      snapshot = payload;
    },
  });
  return { frames, snapshot: () => snapshot };
};

const outputText = (frame: Frame): string => {
  if (frame.kind !== "terminal.output") {
    return "";
  }
  return Buffer.from(
    (frame.payload as { chunk: { dataB64: string } }).chunk.dataB64,
    "base64"
  ).toString("utf8");
};

const createTerminal = async (
  client: OmoClient,
  started: Started,
  mutation: string
): Promise<string> => {
  await client.createTerminal({
    clientMutationId: mutation,
    commandId: `cmd_${mutation}`,
    name: "e2e",
    shell: "cat",
    workspaceId: started.workspaceId,
  });
  const record = await waitFor(() => {
    const candidate = started.daemon.service.getCommand(`cmd_${mutation}`);
    return candidate?.state === "completed" ? candidate : undefined;
  });
  return (record.result as { terminalId: string }).terminalId;
};

const awaitCommand = async (
  started: Started,
  commandId: string
): Promise<void> => {
  await waitFor(() => {
    const record = started.daemon.service.getCommand(commandId);
    return record && ["completed", "failed"].includes(record.state)
      ? true
      : undefined;
  });
};

test("e2e terminal: create → snapshot → control → echo → kill → exit record", async () => {
  const started = await start();
  const client = await OmoClient.pair(started.baseUrl, "code", "term-e2e");

  const terminalId = await createTerminal(client, started, "term-create-1");
  const record = started.daemon.terminals.get(terminalId);
  assert.ok(record);
  assert.equal(record.status, "running");
  assert.ok((record.pid ?? 0) > 0, "real PTY pid recorded");
  assert.equal(record.shell, "cat");

  const sync = await connectSync(client);
  const view = collectTerminal(sync, terminalId);
  await waitFor(() => (view.snapshot() ? true : undefined));
  const snapshot = view.snapshot() as {
    terminal: { status: string; terminalId: string };
  };
  assert.equal(snapshot.terminal.terminalId, terminalId);
  assert.equal(snapshot.terminal.status, "running");

  // Control acquire → input → echo output frames.
  await client.controlTerminal(
    terminalId,
    started.workspaceId,
    "acquire",
    "term-acquire-1"
  );
  await awaitCommand(started, "cmd_control_term-acquire-1");
  sync.sendTerminalInput(terminalId, "echo omo-pty-e2e\n");
  await waitFor(() =>
    view.frames.some((frame) => outputText(frame).includes("omo-pty-e2e"))
      ? true
      : undefined
  );

  // Output offsets are strictly increasing.
  const offsets = view.frames
    .filter((frame) => frame.kind === "terminal.output")
    .map(
      (frame) => (frame.payload as { chunk: { offset: number } }).chunk.offset
    );
  for (let index = 1; index < offsets.length; index += 1) {
    assert.ok(offsets[index] > offsets[index - 1]);
  }

  // Kill via durable command → exit event + record.
  await client.killTerminal(terminalId, started.workspaceId, "term-kill-1");
  await waitFor(() =>
    view.frames.some((frame) => frame.kind === "terminal.exit")
      ? true
      : undefined
  );
  await waitFor(() => {
    const current = started.daemon.terminals.get(terminalId);
    return current?.status === "exited" ? true : undefined;
  });
  assert.equal(
    typeof started.daemon.terminals.get(terminalId)?.exitCode,
    "number"
  );
  sync.close();
});

test("e2e terminal: second device is denied input until control transfer", async () => {
  const started = await start();
  const clientA = await OmoClient.pair(started.baseUrl, "code", "device-A");
  const clientB = await OmoClient.pair(started.baseUrl, "code", "device-B");
  const terminalId = await createTerminal(clientA, started, "term-create-2");

  const syncA = await connectSync(clientA);
  const syncBErrors: { code: string; message: string }[] = [];
  const syncB = await connectSync(clientB, (error) => syncBErrors.push(error));
  const viewB = collectTerminal(syncB, terminalId);
  await waitFor(() => (viewB.snapshot() ? true : undefined));

  // A acquires control; B's input is refused with permission_denied.
  await clientA.controlTerminal(
    terminalId,
    started.workspaceId,
    "acquire",
    "term-acquire-a"
  );
  await awaitCommand(started, "cmd_control_term-acquire-a");
  syncB.sendTerminalInput(terminalId, "echo nope\n");
  await waitFor(() =>
    syncBErrors.some((error) => error.code === "permission_denied")
      ? true
      : undefined
  );

  // B force-takes control via a durable command; then B can type.
  await clientB.controlTerminal(
    terminalId,
    started.workspaceId,
    "force",
    "term-force-1"
  );
  await awaitCommand(started, "cmd_control_term-force-1");
  assert.equal(
    started.daemon.terminals.get(terminalId)?.controllerDeviceId,
    clientB.deviceId
  );
  syncB.sendTerminalInput(terminalId, "echo after-force\n");
  await waitFor(() =>
    viewB.frames.some((frame) => outputText(frame).includes("after-force"))
      ? true
      : undefined
  );
  syncA.close();
  syncB.close();
});

test("e2e terminal: daemon restart orphans the record", async () => {
  const dataDir = makeDir();
  const first = await start(dataDir);
  const clientA = await OmoClient.pair(first.baseUrl, "code", "device-R");
  const terminalId = await createTerminal(clientA, first, "term-create-3");
  assert.equal(first.daemon.terminals.get(terminalId)?.status, "running");

  await first.http.close();
  servers.splice(servers.indexOf(first.http), 1);
  await first.daemon.close();
  daemons.splice(daemons.indexOf(first.daemon), 1);

  const second = await start(dataDir);
  const record = second.daemon.terminals.get(terminalId);
  assert.equal(record?.status, "orphaned", "leftover PTY marked orphaned");
  assert.equal(second.daemon.terminals.liveCount(), 0);

  // Snapshot of an orphaned terminal: durable record, empty tail.
  const clientB = await OmoClient.pair(second.baseUrl, "code", "device-R2");
  const sync = await connectSync(clientB);
  const view = collectTerminal(sync, terminalId);
  await waitFor(() => (view.snapshot() ? true : undefined));
  const snapshot = view.snapshot() as { terminal: { status: string } };
  assert.equal(snapshot.terminal.status, "orphaned");
  sync.close();
});
