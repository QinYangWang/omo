import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const require = createRequire(import.meta.url);
const { DaemonSupervisor } = require("../electron/daemon.cjs");

/**
 * Electron thin-shell supervisor verification (plan §4.2, §12.2 step 2):
 * spawn → health-gate → pair once (token persisted) → config → crash restart
 * with the SAME token → clean stop. Uses the real daemon binary with --faux.
 */

const tempDirs = [];
const makeDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "omo-shell-test-"));
  tempDirs.push(dir);
  return dir;
};

const supervisors = [];

after(async () => {
  for (const supervisor of supervisors) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential cleanup
    await supervisor.stop().catch(() => undefined);
  }
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const memoryStorage = () => {
  let token = null;
  return {
    clear() {
      token = null;
    },
    read: () => token,
    write(next) {
      token = next;
    },
  };
};

const DAEMON_SCRIPT = join(
  import.meta.dirname,
  "..",
  "packages",
  "daemon",
  "bin",
  "omo-daemon.ts"
);

const startSupervisor = async (options = {}) => {
  const dataDir = makeDir();
  const workspaceRoot = makeDir();
  const supervisor = new DaemonSupervisor({
    daemonScript: DAEMON_SCRIPT,
    dataDir,
    providerArgs: ["--faux"],
    tokenStorage: memoryStorage(),
    workspaceRoots: [workspaceRoot],
    ...options,
  });
  supervisors.push(supervisor);
  await supervisor.start();
  return supervisor;
};

test("spawn → health gate → pairing → renderer config with token", async () => {
  const supervisor = await startSupervisor();
  assert.equal(supervisor.state, "ready");
  const config = supervisor.config();
  assert.ok(config);
  assert.ok(config.serverId.startsWith("srv_"));
  assert.ok(config.token.startsWith("omod_"));
  assert.ok(config.baseUrl.startsWith("http://127.0.0.1:"));

  // The issued token authenticates against the daemon API.
  const response = await fetch(`${config.baseUrl}/v1/devices`, {
    headers: { authorization: `Bearer ${config.token}` },
  });
  assert.equal(response.status, 200);
  const { devices } = await response.json();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, "omo desktop");

  await supervisor.stop();
  assert.equal(supervisor.state, "stopped");
});

test("SIGKILL crash → bounded restart with the SAME device token", async () => {
  const storage = memoryStorage();
  const supervisor = await startSupervisor({ tokenStorage: storage });
  const first = supervisor.config();
  assert.ok(first);
  const firstPid = supervisor.childPid;
  assert.ok(firstPid);

  const restarted = new Promise((resolve) => {
    const unsubscribe = supervisor.onStateChange((state) => {
      if (state === "ready" && supervisor.childPid !== firstPid) {
        unsubscribe();
        resolve(true);
      }
    });
  });

  // Hard-kill the daemon child; the supervisor must notice and restart.
  process.kill(firstPid, "SIGKILL");
  const restartedInTime = await Promise.race([
    restarted,
    new Promise((resolve) => setTimeout(() => resolve(false), 30_000)),
  ]);
  assert.equal(restartedInTime, true, "supervisor must restart the daemon");

  // Same device token, same server identity (the control DB survived).
  const second = supervisor.config();
  assert.ok(second);
  assert.equal(second.token, first.token);
  assert.equal(second.serverId, first.serverId);
  const response = await fetch(`${second.baseUrl}/v1/devices`, {
    headers: { authorization: `Bearer ${second.token}` },
  });
  assert.equal(response.status, 200);

  await supervisor.stop();
});
