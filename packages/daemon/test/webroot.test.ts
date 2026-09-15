import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { openDaemon } from "../src/daemon.ts";
import { DaemonHttpServer } from "../src/http.ts";
import { FakeRuntime, FakeSessionStore } from "./helpers/fake-runtime.ts";

/**
 * Web bundle serving (server deployment form, v1 OMO_WEB_ROOT parity):
 * non-/v1 GET paths serve the built SPA with traversal guard and index.html
 * fallback; protocol routes are untouched.
 */

const htmlContentType = /text\/html/;
const javascriptContentType = /javascript/;
const appContent = /omo app/;
const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "omo-p2-webroot-"));
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

test("web root: serves index, assets with MIME, SPA fallback, guards traversal", async () => {
  const webRoot = makeDir();
  writeFileSync(
    join(webRoot, "index.html"),
    "<html><body>omo app</body></html>"
  );
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "assets", "app.js"), "console.log(1)");

  const daemon = openDaemon({
    dataDir: makeDir(),
    pairingCode: "code",
    runtime: new FakeRuntime(new FakeSessionStore()),
    workspaceRoots: [makeDir()],
  });
  daemons.push(daemon);
  const http = new DaemonHttpServer(daemon, { webRoot });
  servers.push(http);
  const { port } = await http.listen(0);
  const base = `http://127.0.0.1:${port}`;

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type") ?? "", htmlContentType);
  assert.equal(index.headers.get("cache-control"), "no-store");
  assert.match(await index.text(), appContent);

  const asset = await fetch(`${base}/assets/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", javascriptContentType);
  assert.equal(
    asset.headers.get("cache-control"),
    "public, max-age=31536000, immutable"
  );

  // SPA fallback: unknown client-side route → index.html.
  const spa = await fetch(`${base}/some/client/route`);
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), appContent);

  // Traversal never escapes the web root.
  const escapeResponse = await fetch(`${base}/../../etc/passwd`);
  assert.equal(escapeResponse.status, 200); // SPA fallback, not file content
  assert.match(await escapeResponse.text(), appContent);
  const encoded = await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`);
  assert.match(await encoded.text(), appContent);

  // Protocol untouched and still public.
  const hello = await fetch(`${base}/v1/hello`);
  assert.equal(hello.status, 200);

  // Without a web root, non-protocol paths still 404.
  const daemon2 = openDaemon({
    dataDir: makeDir(),
    pairingCode: "code",
    runtime: new FakeRuntime(new FakeSessionStore()),
    workspaceRoots: [makeDir()],
  });
  daemons.push(daemon2);
  const http2 = new DaemonHttpServer(daemon2);
  servers.push(http2);
  const { port: port2 } = await http2.listen(0);
  const missing = await fetch(`http://127.0.0.1:${port2}/`);
  assert.equal(missing.status, 404);
});
