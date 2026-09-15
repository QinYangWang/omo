import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { OmoCommandError } from "@omo/protocol/errors";
import { openDurableDatabase } from "@omo/storage/durable-database";
import {
  type PtySpawner,
  type TerminalEvent,
  TerminalManager,
} from "../src/terminal.ts";

/**
 * TerminalManager unit verification (plan §6.6, §8.4, §5.8): durable record
 * vs volatile tail, input ownership with connection-aware handover, bounded
 * output with floor/reset semantics, and restart orphaning. The PTY itself
 * is faked; the e2e suite uses a real node-pty roundtrip.
 */

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p2-term-"));
  tempDirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

interface FakeProc {
  data: (data: string) => void;
  exit: (event: { exitCode: number }) => void;
  killed: boolean;
  pid: number;
  resized: [number, number][];
  written: string[];
}

const fakeSpawner = () => {
  const procs = new Map<number, FakeProc>();
  let nextPid = 10_000;
  const spawner: PtySpawner = () => {
    const pid = nextPid;
    nextPid += 1;
    const proc: FakeProc = {
      data: () => undefined,
      exit: () => undefined,
      killed: false,
      pid,
      resized: [],
      written: [],
    };
    procs.set(pid, proc);
    return {
      kill: () => {
        proc.killed = true;
      },
      onData: (listener) => {
        proc.data = listener;
      },
      onExit: (listener) => {
        proc.exit = listener;
      },
      pid,
      resize: (cols, rows) => {
        proc.resized.push([cols, rows]);
      },
      write: (data) => {
        proc.written.push(data);
      },
    };
  };
  return { procs, spawner };
};

const PRINCIPAL_A = { deviceId: "dev_a", userId: "usr_t" };
const PRINCIPAL_B = { deviceId: "dev_b", userId: "usr_t" };

const setup = (options?: {
  isDeviceConnected?: (deviceId: string) => boolean;
  maxBufferBytes?: number;
}) => {
  const { db } = openDurableDatabase(join(makeDir(), "control.sqlite"));
  const { procs, spawner } = fakeSpawner();
  const events: TerminalEvent[] = [];
  const manager = new TerminalManager({
    db,
    isDeviceConnected: options?.isDeviceConnected,
    maxBufferBytes: options?.maxBufferBytes,
    onEvent: (event) => events.push(event),
    spawner,
  });
  return { db, events, manager, procs };
};

const createOne = (manager: TerminalManager) =>
  manager.create({
    cols: 80,
    rows: 24,
    shell: "/bin/cat",
    terminalId: "trm_test_1",
    workspaceId: "wks_1",
    workspacePath: "/tmp",
  });

test("create persists the record; output tail is volatile with offsets", () => {
  const { manager, procs } = setup();
  const record = createOne(manager);
  assert.equal(record.status, "running");
  assert.ok(record.pid);
  assert.equal(record.cols, 80);

  const proc = procs.get(record.pid as number);
  assert.ok(proc);
  proc.data("hello ");
  proc.data("world");
  const snapshot = manager.snapshot(record.terminalId);
  assert.ok(snapshot);
  assert.equal(snapshot.tail.length, 2);
  assert.equal(snapshot.tail[0].offset, 0);
  assert.equal(snapshot.tail[1].offset, 6);
  assert.equal(
    Buffer.from(snapshot.tail[1].dataB64, "base64").toString("utf8"),
    "world"
  );
  // Incremental read past the first chunk.
  const incremental = manager.snapshot(record.terminalId, 6);
  assert.equal(incremental?.tail.length, 1);
  manager.closeAll();
});

test("bounded tail advances the floor; stale readers must reset", () => {
  const { manager, procs } = setup({ maxBufferBytes: 12 });
  const record = createOne(manager);
  const proc = procs.get(record.pid as number);
  assert.ok(proc);
  for (const chunk of ["aaaa", "bbbb", "cccc", "dddd"]) {
    proc.data(chunk);
  }
  const snapshot = manager.snapshot(record.terminalId);
  assert.ok(snapshot);
  assert.equal(snapshot.floor, 4, "oldest chunk dropped under the byte cap");
  assert.equal(snapshot.tail.length, 3);
  assert.throws(
    () => manager.snapshot(record.terminalId, 0),
    (error: unknown) =>
      error instanceof OmoCommandError && error.code === "reset_required"
  );
  manager.closeAll();
});

test("input ownership: acquire → input; others rejected; release; force", () => {
  const { manager } = setup();
  const record = createOne(manager);
  const { terminalId } = record;

  // No controller: everyone is rejected.
  assert.throws(
    () => manager.writeInput(terminalId, PRINCIPAL_A, "x"),
    (error: unknown) =>
      error instanceof OmoCommandError && error.code === "permission_denied"
  );

  manager.control(terminalId, PRINCIPAL_A, "acquire");
  manager.writeInput(terminalId, PRINCIPAL_A, "echo a\n");
  assert.throws(
    () => manager.writeInput(terminalId, PRINCIPAL_B, "echo b\n"),
    (error: unknown) =>
      error instanceof OmoCommandError && error.code === "permission_denied"
  );

  // B cannot acquire while A is connected, but CAN force (audited).
  assert.throws(
    () => manager.control(terminalId, PRINCIPAL_B, "acquire"),
    (error: unknown) =>
      error instanceof OmoCommandError && error.code === "permission_denied"
  );
  const forced = manager.control(terminalId, PRINCIPAL_B, "force");
  assert.equal(forced.controllerDeviceId, "dev_b");
  manager.writeInput(terminalId, PRINCIPAL_B, "echo b\n");

  // Only the controller can release.
  assert.throws(
    () => manager.control(terminalId, PRINCIPAL_A, "release"),
    (error: unknown) =>
      error instanceof OmoCommandError && error.code === "permission_denied"
  );
  const released = manager.control(terminalId, PRINCIPAL_B, "release");
  assert.equal(released.controllerDeviceId, undefined);
  manager.closeAll();
});

test("disconnected controller yields control WITHOUT force (§6.6)", () => {
  const connected = new Set(["dev_a"]);
  const { manager } = setup({
    isDeviceConnected: (deviceId) => connected.has(deviceId),
  });
  const record = createOne(manager);
  manager.control(record.terminalId, PRINCIPAL_A, "acquire");

  // A drops off: B acquires without force.
  connected.clear();
  const handed = manager.control(record.terminalId, PRINCIPAL_B, "acquire");
  assert.equal(handed.controllerDeviceId, "dev_b");
  manager.closeAll();
});

test("resize is controller-only; exit is recorded; restart orphans records", () => {
  const { db, manager, procs } = setup();
  const record = createOne(manager);
  const { terminalId } = record;

  assert.throws(
    () => manager.resize(terminalId, PRINCIPAL_B, 100, 40),
    (error: unknown) =>
      error instanceof OmoCommandError && error.code === "permission_denied"
  );
  manager.control(terminalId, PRINCIPAL_A, "acquire");
  manager.resize(terminalId, PRINCIPAL_A, 100, 40);
  const proc = procs.get(record.pid as number);
  assert.deepEqual(proc?.resized, [[100, 40]]);
  assert.equal(manager.get(terminalId)?.cols, 100);

  // Process exit becomes a durable fact.
  proc?.exit({ exitCode: 3 });
  assert.equal(manager.get(terminalId)?.status, "exited");
  assert.equal(manager.get(terminalId)?.exitCode, 3);
  assert.throws(
    () => manager.writeInput(terminalId, PRINCIPAL_A, "x"),
    (error: unknown) =>
      error instanceof OmoCommandError && error.code === "operation_mismatch"
  );

  // A NEW manager over the same DB marks leftovers orphaned (§8.4).
  const second = manager.create({
    cols: 80,
    rows: 24,
    shell: "/bin/cat",
    terminalId: "trm_test_2",
    workspaceId: "wks_1",
    workspacePath: "/tmp",
  });
  const events: TerminalEvent[] = [];
  const manager2 = new TerminalManager({
    db,
    onEvent: (event) => events.push(event),
    spawner: fakeSpawner().spawner,
  });
  assert.equal(manager2.get(second.terminalId)?.status, "orphaned");
  assert.ok(events.some((event) => event.kind === "orphaned"));
  manager.closeAll();
});
