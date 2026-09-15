import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { openDaemon } from "../src/daemon.ts";
import { DaemonHttpServer } from "../src/http.ts";
import { FakeRuntime, FakeSessionStore } from "./helpers/fake-runtime.ts";

/**
 * TLS serving (plan §4.2: 非 loopback 必须显式开 TLS): the daemon serves
 * HTTPS + WSS from the same TLS listener when cert/key are provided.
 */

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p2-tls-"));
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

const hasOpenssl = (): boolean => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

test("daemon serves HTTPS with provided cert/key; hello handshakes over TLS", async (t) => {
  if (!hasOpenssl()) {
    t.skip("openssl unavailable");
    return;
  }
  const dir = makeDir();
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
  ]);

  const daemon = openDaemon({
    dataDir: makeDir(),
    pairingCode: "code",
    runtime: new FakeRuntime(new FakeSessionStore()),
    workspaceRoots: [makeDir()],
  });
  daemons.push(daemon);
  const { readFileSync } = await import("node:fs");
  const http = new DaemonHttpServer(daemon, {
    tls: {
      cert: readFileSync(certPath, "utf8"),
      key: readFileSync(keyPath, "utf8"),
    },
  });
  servers.push(http);
  const { port } = await http.listen(0);

  // Self-signed: the client must opt out of CA verification explicitly.
  const response = await fetch(`https://127.0.0.1:${port}/v1/hello`, {
    // @ts-expect-error undici-specific flag for the test
    dispatcher: new (await import("undici")).Agent({
      connect: { rejectUnauthorized: false },
    }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    identity: { serverId: string };
  };
  assert.equal(body.identity.serverId, daemon.identity.serverId);
});
