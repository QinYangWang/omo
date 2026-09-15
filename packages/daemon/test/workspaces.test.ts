import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { OmoCommandError } from "@omo/protocol/errors";
import { openDurableDatabase } from "@omo/storage/durable-database";
import { SessionCatalog, WorkspaceRegistry } from "../src/workspaces.ts";

/**
 * Workspace registry + path guard verification (plan §10.2, §13 P1):
 * fail-closed registration under configured roots, canonical-path dedup,
 * symlink/TOCTOU-aware resolution, and the session catalog projection.
 */

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p1-ws-"));
  tempDirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const openRegistry = (roots: string[]) => {
  const { db } = openDurableDatabase(join(makeDir(), "control.sqlite"));
  return { db, registry: WorkspaceRegistry.attach(db, roots) };
};

const expectCode = (code: string) => (error: unknown) =>
  error instanceof OmoCommandError && error.code === code;

test("registration is fail-closed: outside roots, missing paths, non-directories", () => {
  const root = makeDir();
  const { db, registry } = openRegistry([root]);

  const inside = join(root, "project");
  mkdirSync(inside);
  const record = registry.register({ name: "project", path: inside });
  assert.ok(record.workspaceId.startsWith("wks_"));
  assert.equal(record.path, inside);

  assert.throws(
    () => registry.register({ path: join(root, "missing") }),
    expectCode("unknown_workspace")
  );

  const filePath = join(root, "a-file");
  writeFileSync(filePath, "x");
  assert.throws(
    () => registry.register({ path: filePath }),
    expectCode("unknown_workspace")
  );

  assert.throws(
    () => registry.register({ path: makeDir() }),
    expectCode("permission_denied")
  );
  db.close();
});

test("registration dedups by canonical path, including through symlinks", () => {
  const root = makeDir();
  const { db, registry } = openRegistry([root]);
  const real = join(root, "project");
  mkdirSync(real);
  const link = join(root, "project-link");
  symlinkSync(real, link);

  const first = registry.register({ path: real });
  const second = registry.register({ path: link });
  const third = registry.register({ path: join(real, ".", "..", "project") });
  assert.equal(second.workspaceId, first.workspaceId);
  assert.equal(third.workspaceId, first.workspaceId);
  assert.equal(registry.list().length, 1);
  db.close();
});

test("guard rejects escapes: .., absolute paths, symlinks out of the workspace", () => {
  const root = makeDir();
  const { db, registry } = openRegistry([root]);
  const workspace = registry.register({ path: root });
  const { workspaceId } = workspace;

  writeFileSync(join(root, "ok.txt"), "hello");
  assert.equal(
    registry.resolveExisting(workspaceId, "ok.txt"),
    join(root, "ok.txt")
  );
  assert.throws(
    () => registry.resolveExisting(workspaceId, "../outside.txt"),
    expectCode("permission_denied")
  );
  assert.throws(
    () => registry.resolveExisting(workspaceId, "/etc/passwd"),
    expectCode("permission_denied")
  );
  assert.throws(
    () => registry.resolveExisting(workspaceId, "missing.txt"),
    expectCode("unknown_command")
  );

  const outside = makeDir();
  const escapeLink = join(root, "escape");
  symlinkSync(outside, escapeLink);
  assert.throws(
    () => registry.resolveExisting(workspaceId, "escape"),
    expectCode("permission_denied")
  );
  assert.throws(
    () => registry.resolveForWrite(workspaceId, "escape/new.txt"),
    expectCode("permission_denied")
  );

  // New file in an existing in-workspace directory resolves for write.
  mkdirSync(join(root, "src"));
  assert.equal(
    registry.resolveForWrite(workspaceId, "src/new.ts"),
    join(root, "src", "new.ts")
  );
  // New file in a MISSING parent directory is rejected (no implicit mkdir).
  assert.throws(
    () => registry.resolveForWrite(workspaceId, "no-such-dir/new.ts"),
    expectCode("unknown_command")
  );
  db.close();
});

test("session catalog binds sessions to workspaces", () => {
  const root = makeDir();
  const { db, registry } = openRegistry([root]);
  const catalog = SessionCatalog.attach(db);
  const workspace = registry.register({ path: root });

  catalog.record({
    name: "one",
    sessionId: "ses_1",
    workspaceId: workspace.workspaceId,
  });
  catalog.record({ sessionId: "ses_2", workspaceId: workspace.workspaceId });
  // Re-recording is idempotent (ON CONFLICT DO NOTHING).
  catalog.record({
    name: "renamed-ignored",
    sessionId: "ses_1",
    workspaceId: workspace.workspaceId,
  });

  assert.equal(catalog.get("ses_1")?.name, "one");
  const listed = catalog.listByWorkspace(workspace.workspaceId);
  assert.equal(listed.length, 2);
  assert.equal(catalog.listByWorkspace("wks_other").length, 0);
  db.close();
});
