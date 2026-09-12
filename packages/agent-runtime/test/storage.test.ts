import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createSessionRepoConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import { SqliteSessionRepo } from "@earendil-works/pi-session-backend-sqlite-node";
import { readDurabilityReport } from "@omo/storage/durability";
import { createDurableSqliteFactory } from "@omo/storage/session-backend";

/**
 * P0 storage verification (plan §3.4, §5.8):
 *  1. omo's durable factory enforces WAL + synchronous=FULL and proves it by
 *     reading the effective pragmas back.
 *  2. The upstream SQLite session backend passes the upstream SessionRepo
 *     conformance suite through that factory.
 */

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p0-storage-"));
  tempDirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("durable factory enforces and reports WAL + synchronous=FULL", async () => {
  const factory = createDurableSqliteFactory();
  const path = join(makeDir(), "check.sqlite");
  const db = await factory.open(path);
  const report = readDurabilityReport(db);
  assert.equal(report.journalMode, "wal");
  assert.equal(report.synchronous, 2, "synchronous must be FULL (2)");
  if (process.platform === "darwin") {
    assert.equal(report.fullfsync, 1);
  }
  db.close();

  const readonly = await factory.openReadOnly(path);
  const readonlyReport = readDurabilityReport(readonly);
  assert.equal(readonlyReport.synchronous, 2);
  readonly.close();
});

test("upstream SessionRepo conformance via durable factory", async (t) => {
  const cases = createSessionRepoConformance(
    async () =>
      new SqliteSessionRepo({
        databaseFactory: createDurableSqliteFactory(),
        directory: makeDir(),
      })
  );
  assert.ok(cases.length > 0, "conformance suite must produce cases");
  // Conformance cases own fresh repos and must run sequentially.
  for (const conformanceCase of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design; each case opens its own repo
    await t.test(
      `${conformanceCase.group}: ${conformanceCase.name}`,
      async () => {
        await conformanceCase.run();
      }
    );
  }
});
