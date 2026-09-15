import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { CommandInbox, type CommandRecord } from "@omo/control-plane/inbox";
import { openDurableDatabase } from "@omo/storage/durable-database";
import { openDaemon } from "../src/daemon.ts";
import { sha256Hex } from "../src/files.ts";
import { WorkspaceRegistry } from "../src/workspaces.ts";
import {
  FakeRuntime,
  FakeSessionStore,
  waitFor,
} from "./helpers/fake-runtime.ts";

/**
 * file.save verification (plan §5.8.3/§5.8.4, §6.6): CAS by base hash,
 * durable write protocol (temp → fsync → rename → dir fsync → receipt), and
 * crash reconciliation decided from the file's ACTUAL content.
 */

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p1-file-"));
  tempDirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const PRINCIPAL = { deviceId: "dev_file", userId: "usr_file" };

interface Started {
  daemon: ReturnType<typeof openDaemon>;
  workspaceDir: string;
  workspaceId: string;
}

const start = (options?: { dataDir?: string }): Started => {
  const dataDir = options?.dataDir ?? makeDir();
  const rootDir = makeDir();
  const workspaceDir = join(rootDir, "ws");
  const daemon = openDaemon({
    dataDir,
    pairingCode: "code",
    runtime: new FakeRuntime(new FakeSessionStore()),
    workspaceRoots: [rootDir],
  });
  mkdirSync(workspaceDir, { recursive: true });
  const { workspaceId } = daemon.workspaces.register({ path: workspaceDir });
  return { daemon, workspaceDir, workspaceId };
};

const submitSave = (
  daemon: Started["daemon"],
  workspaceId: string,
  mutation: string,
  payload: Record<string, unknown>
) =>
  daemon.service.submit(
    {
      clientMutationId: mutation,
      commandId: `cmd_save_${mutation}`,
      kind: "file.save",
      payload,
      scope: { workspaceId },
    },
    PRINCIPAL
  );

const awaitTerminal = (
  daemon: Started["daemon"],
  commandId: string
): Promise<CommandRecord> =>
  waitFor<CommandRecord>(() => {
    const record = daemon.service.getCommand(commandId);
    return record && ["completed", "failed", "cancelled"].includes(record.state)
      ? record
      : undefined;
  });

test("create → save with CAS → conflict on stale baseHash", async () => {
  const { daemon, workspaceDir, workspaceId } = start();

  submitSave(daemon, workspaceId, "create", {
    contentText: "v1\n",
    path: "notes.txt",
  });
  const created = await awaitTerminal(daemon, "cmd_save_create");
  assert.equal(created.state, "completed");
  const createResult = created.result as {
    created: boolean;
    hash: string;
    kind: string;
  };
  assert.equal(createResult.created, true);
  assert.equal(createResult.kind, "applied");
  assert.equal(readFileSync(join(workspaceDir, "notes.txt"), "utf8"), "v1\n");
  assert.equal(createResult.hash, sha256Hex(Buffer.from("v1\n", "utf8")));

  // Saving an existing file without baseHash is a conflict, not an overwrite.
  submitSave(daemon, workspaceId, "nocas", {
    contentText: "v2\n",
    path: "notes.txt",
  });
  const noCas = await awaitTerminal(daemon, "cmd_save_nocas");
  assert.equal(noCas.state, "failed");
  assert.equal((noCas.error as { code: string }).code, "revision_mismatch");
  assert.equal(readFileSync(join(workspaceDir, "notes.txt"), "utf8"), "v1\n");

  // Correct CAS applies; stale CAS does not.
  submitSave(daemon, workspaceId, "v2", {
    baseHash: createResult.hash,
    contentText: "v2\n",
    path: "notes.txt",
  });
  const v2 = await awaitTerminal(daemon, "cmd_save_v2");
  assert.equal(v2.state, "completed");
  assert.equal((v2.result as { created: boolean }).created, false);
  assert.equal(readFileSync(join(workspaceDir, "notes.txt"), "utf8"), "v2\n");

  submitSave(daemon, workspaceId, "stale", {
    baseHash: createResult.hash, // v1 hash, no longer current
    contentText: "v3\n",
    path: "notes.txt",
  });
  const stale = await awaitTerminal(daemon, "cmd_save_stale");
  assert.equal(stale.state, "failed");
  assert.equal((stale.error as { code: string }).code, "revision_mismatch");
  assert.equal(readFileSync(join(workspaceDir, "notes.txt"), "utf8"), "v2\n");

  // Identical content with the current hash is a durable noop.
  submitSave(daemon, workspaceId, "noop", {
    baseHash: (v2.result as { hash: string }).hash,
    contentText: "v2\n",
    path: "notes.txt",
  });
  const noop = await awaitTerminal(daemon, "cmd_save_noop");
  assert.equal(noop.state, "completed");
  assert.equal((noop.result as { kind: string }).kind, "noop");

  await daemon.close();
});

test("baseHash against a missing file is a conflict; escapes are refused", async () => {
  const { daemon, workspaceId } = start();

  submitSave(daemon, workspaceId, "ghost", {
    baseHash: sha256Hex(Buffer.from("x")),
    contentText: "y",
    path: "ghost.txt",
  });
  const ghost = await awaitTerminal(daemon, "cmd_save_ghost");
  assert.equal(ghost.state, "failed");
  assert.equal((ghost.error as { code: string }).code, "revision_mismatch");

  submitSave(daemon, workspaceId, "escape", {
    contentText: "x",
    path: "../evil.txt",
  });
  const escapeAttempt = await awaitTerminal(daemon, "cmd_save_escape");
  assert.equal(escapeAttempt.state, "failed");
  assert.equal(
    (escapeAttempt.error as { code: string }).code,
    "permission_denied"
  );

  submitSave(daemon, workspaceId, "abs", {
    contentText: "x",
    path: "/tmp/evil-omo.txt",
  });
  const absolute = await awaitTerminal(daemon, "cmd_save_abs");
  assert.equal(absolute.state, "failed");
  assert.equal((absolute.error as { code: string }).code, "permission_denied");

  submitSave(daemon, workspaceId, "twocontents", {
    contentBase64: Buffer.from("a").toString("base64"),
    contentText: "a",
    path: "two.txt",
  });
  const two = await awaitTerminal(daemon, "cmd_save_twocontents");
  assert.equal(two.state, "failed");
  assert.equal((two.error as { code: string }).code, "unknown_schema");

  await daemon.close();
});

/**
 * Craft a non-terminal file.save command + a given on-disk state, then let a
 * fresh daemon reconcile it (§5.8.4: 已应用 / 未应用 / 冲突 by content).
 */
const craftAndReconcile = async (
  onDisk: "base" | "target" | "third"
): Promise<{ result?: unknown; state?: string; error?: unknown }> => {
  const dataDir = makeDir();
  const rootDir = makeDir();
  const workspaceDir = join(rootDir, "ws");
  mkdirSync(workspaceDir, { recursive: true });

  const base = Buffer.from("base\n", "utf8");
  const target = Buffer.from("target\n", "utf8");
  const payload = {
    baseHash: sha256Hex(base),
    contentText: target.toString("utf8"),
    path: "recover.txt",
  };
  if (onDisk === "base") {
    writeFileSync(join(workspaceDir, "recover.txt"), base);
  } else if (onDisk === "target") {
    writeFileSync(join(workspaceDir, "recover.txt"), target);
  } else {
    writeFileSync(join(workspaceDir, "recover.txt"), "someone else\n");
  }

  {
    const { db } = openDurableDatabase(join(dataDir, "control.sqlite"));
    const { workspaceId } = WorkspaceRegistry.attach(db, [rootDir]).register({
      path: workspaceDir,
    });
    const inbox = CommandInbox.attach(db);
    inbox.receive(
      {
        clientMutationId: "mut-recover",
        commandId: "cmd_recover_save",
        kind: "file.save",
        operationId: "op_save_recover",
        payload,
        scope: { workspaceId },
      },
      PRINCIPAL
    );
    inbox.markAdmitted("cmd_recover_save", "op_save_recover");
    db.close();
  }

  const { daemon } = start({ dataDir });
  const record = await awaitTerminal(daemon, "cmd_recover_save");
  const outcome = {
    error: record.error,
    result: record.result,
    state: record.state,
  };
  await daemon.close();
  return outcome;
};

test("crash after rename (file at target): reconcile completes WITHOUT rewriting", async () => {
  const outcome = await craftAndReconcile("target");
  assert.equal(outcome.state, "completed");
  // Detected as already-applied: noop, not a second write.
  assert.equal((outcome.result as { kind: string }).kind, "noop");
});

test("crash before rename (file at base): reconcile re-applies the save", async () => {
  const outcome = await craftAndReconcile("base");
  assert.equal(outcome.state, "completed");
  assert.equal((outcome.result as { kind: string }).kind, "applied");
});

test("crash with a third-party modification: conflict, not silent overwrite", async () => {
  const outcome = await craftAndReconcile("third");
  assert.equal(outcome.state, "failed");
  assert.equal((outcome.error as { code: string }).code, "revision_mismatch");
});
