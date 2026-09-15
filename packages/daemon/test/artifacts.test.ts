import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { OmoCommandError } from "@omo/protocol/errors";
import { openDaemon } from "../src/daemon.ts";
import { sha256Hex } from "../src/files.ts";
import { DaemonHttpServer } from "../src/http.ts";
import { FakeRuntime, FakeSessionStore } from "./helpers/fake-runtime.ts";

/**
 * Artifact store verification (plan §5.3, §5.8.3): content addressing,
 * publish protocol (object on disk BEFORE the metadata row), idempotent put,
 * read-time integrity, orphan GC and the HTTP surface.
 */

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p1-art-"));
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

const start = (dataDir = makeDir()) => {
  const daemon = openDaemon({
    dataDir,
    pairingCode: "code",
    runtime: new FakeRuntime(new FakeSessionStore()),
    workspaceRoots: [makeDir()],
  });
  daemons.push(daemon);
  return daemon;
};

test("put is content-addressed, idempotent and integrity-checked on read", async () => {
  const daemon = start();
  const bytes = Buffer.from("hello artifact".repeat(100));

  const first = daemon.artifacts.put(bytes, {
    mime: "text/plain",
    name: "a.txt",
  });
  assert.ok(first.artifactId.startsWith("art_"));
  assert.equal(first.sha256, sha256Hex(bytes));
  assert.equal(first.size, bytes.length);

  // Same content → the SAME record; nothing is written twice.
  const second = daemon.artifacts.put(bytes);
  assert.equal(second.artifactId, first.artifactId);
  assert.equal(daemon.artifacts.list().length, 1);

  const read = daemon.artifacts.readBytes(first);
  assert.equal(read.equals(bytes), true);

  // Corrupt the object on disk: reads must fail loudly (§5.8.3).
  const objectPath = join(
    daemon.artifacts.rootDir,
    "objects",
    first.sha256.slice(0, 2),
    first.sha256
  );
  writeFileSync(objectPath, "corrupted");
  assert.throws(
    () => daemon.artifacts.readBytes(first),
    (error: unknown) =>
      error instanceof OmoCommandError && error.code === "storage_unavailable"
  );
  await daemon.close();
});

test("orphan sweep removes crash-leftover objects but never referenced ones", async () => {
  const dataDir = makeDir();
  const daemon = start(dataDir);
  const kept = daemon.artifacts.put(Buffer.from("referenced"));
  await daemon.close();
  daemons.pop(); // closed above

  // Plant an orphan object and a stale temp file (crashed publishes).
  const orphanHash = sha256Hex(Buffer.from("orphan"));
  const shard = join(dataDir, "artifacts", "objects", orphanHash.slice(0, 2));
  mkdirSync(shard, { recursive: true });
  const orphanPath = join(shard, orphanHash);
  writeFileSync(orphanPath, "orphan");
  const tmpPath = join(dataDir, "artifacts", "tmp", "stale-upload");
  writeFileSync(tmpPath, "partial");
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(orphanPath, old, old);
  utimesSync(tmpPath, old, old);

  const reopened = start(dataDir); // sweep runs at open
  assert.equal(reopened.artifacts.list().length, 1);
  assert.equal(reopened.artifacts.list()[0].artifactId, kept.artifactId);
  // Referenced object still reads fine.
  assert.equal(
    reopened.artifacts.readBytes(kept).toString("utf8"),
    "referenced"
  );
  assert.equal(existsSync(orphanPath), false);
  assert.equal(existsSync(tmpPath), false);
  await reopened.close();
});

test("artifacts over HTTP: upload, download with sha256 header, list", async () => {
  const daemon = start();
  const http = new DaemonHttpServer(daemon);
  servers.push(http);
  const { port } = await http.listen(0);
  const base = `http://127.0.0.1:${port}`;

  const pairing = await fetch(`${base}/v1/pairing`, {
    body: JSON.stringify({ code: "code" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const { token } = (await pairing.json()) as { token: string };

  const payload = Buffer.from(`binary-${"x".repeat(1000)}`);
  const uploaded = await fetch(`${base}/v1/artifacts`, {
    body: payload,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "x-omo-name": "blob.bin",
    },
    method: "POST",
  });
  assert.equal(uploaded.status, 201);
  const { artifact } = (await uploaded.json()) as {
    artifact: { artifactId: string; sha256: string; size: number };
  };
  assert.equal(artifact.sha256, sha256Hex(payload));

  const downloaded = await fetch(
    `${base}/v1/artifacts/${artifact.artifactId}`,
    {
      headers: { authorization: `Bearer ${token}` },
    }
  );
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("x-omo-sha256"), artifact.sha256);
  const body = Buffer.from(await downloaded.arrayBuffer());
  assert.equal(body.equals(payload), true);

  const listed = await fetch(`${base}/v1/artifacts`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(
    ((await listed.json()) as { artifacts: unknown[] }).artifacts.length,
    1
  );

  const missing = await fetch(`${base}/v1/artifacts/art_missing`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(missing.status, 404);
});
