import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { openDaemon } from "../src/daemon.ts";
import { NdjsonTelemetry } from "../src/telemetry.ts";
import {
  FakeRuntime,
  FakeSessionStore,
  waitFor,
} from "./helpers/fake-runtime.ts";

/**
 * Telemetry verification (plan §10.3): spans are appended to a bounded local
 * NDJSON log, rotation drops old data instead of growing without bound, and
 * sink failures never break business operations.
 */

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p2-telemetry-"));
  tempDirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("command submit/execute spans land in the bounded NDJSON log", async () => {
  const dataDir = makeDir();
  const rootDir = makeDir();
  const daemon = openDaemon({
    dataDir,
    pairingCode: "code",
    runtime: new FakeRuntime(new FakeSessionStore()),
    workspaceRoots: [rootDir],
  });
  mkdirSync(join(rootDir, "ws"), { recursive: true });
  const { workspaceId } = daemon.workspaces.register({
    path: join(rootDir, "ws"),
  });
  daemon.service.submit(
    {
      clientMutationId: "t1",
      commandId: "cmd_telemetry",
      kind: "session.create",
      payload: {},
      scope: { workspaceId },
    },
    { deviceId: "dev_t", userId: "usr_t" }
  );
  await waitFor(() => {
    const record = daemon.service.getCommand("cmd_telemetry");
    return record?.state === "completed" ? record : undefined;
  });

  const log = readFileSync(join(dataDir, "telemetry.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { name: string });
  const names = log.map((record) => record.name);
  assert.ok(names.includes("omo.command.submit"));
  assert.ok(names.includes("omo.command.execute"));
  await daemon.close();
});

test("rotation bounds the log; a read-only data dir never breaks commands", async () => {
  const dir = makeDir();
  const telemetry = new NdjsonTelemetry({
    filePath: join(dir, "telemetry.ndjson"),
    maxBytes: 512,
  });
  for (let index = 0; index < 20; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential rotation check
    await telemetry.startSpan({ name: "omo.test" }, () => "ok");
  }
  const { size } = statSync(join(dir, "telemetry.ndjson"));
  assert.ok(size < 4096, `log must stay bounded, got ${size}`);

  // A sink that cannot write must never throw into the business path.
  const broken = new NdjsonTelemetry({
    filePath: join(dir, "missing", "deeply", "telemetry.ndjson"),
  });
  const result = await broken.startSpan({ name: "omo.test" }, () => 42);
  assert.equal(result, 42);
});
