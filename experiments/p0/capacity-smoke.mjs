/**
 * P0 experiment 4 — multi-process Session Worker capacity smoke (plan §8.1,
 * §13 P0 交付 6).
 *
 * Spawns W independent OS processes, each owning its own root session on its
 * own WAL + FULL database, all driving faux-provider operations concurrently.
 * The parent proves every worker ADVANCES (operation count grows), records
 * per-worker and total RSS, and measures drive latency distribution.
 *
 * This is a SMOKE run: the reference workload is 100 workers on the
 * 16 CPU / 32 GiB reference profile (ADR-006). This development machine
 * (2 CPU / 8 GiB) runs a reduced scale; full 100-worker numbers must be
 * produced on reference hardware with the same script:
 *
 *   node --no-warnings experiments/p0/capacity-smoke.mjs [workers] [durationMs]
 *
 * Default: 8 workers × 15s.
 */
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKERS = Number(process.argv[2] ?? "8");
const DURATION_MS = Number(process.argv[3] ?? "15000");

const report = { assertions: [], ok: true };
const check = (name, condition, detail = "") => {
  report.assertions.push({ detail, name, ok: condition });
  if (!condition) {
    report.ok = false;
  }
};

const dir = mkdtempSync(join(tmpdir(), "omo-p0-capacity-"));
const workerPath = fileURLToPath(
  new URL("./helpers/session-worker.mjs", import.meta.url)
);

const workers = new Map(); // workerId -> { child, lastProgress, final, snapshots: [] }
const startedAt = Date.now();

const spawnWorker = (workerId) => {
  const child = fork(workerPath, [String(workerId), dir, String(DURATION_MS)], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const state = { child, final: undefined, snapshots: [] };
  child.on("message", (message) => {
    if (message?.type === "progress") {
      state.snapshots.push(message);
      if (message.final) {
        state.final = message;
      }
    }
  });
  child.on("exit", (code) => {
    state.exitCode = code;
  });
  workers.set(workerId, state);
};

for (let workerId = 0; workerId < WORKERS; workerId += 1) {
  spawnWorker(workerId);
}

const deadline = Date.now() + DURATION_MS + 30_000;
await new Promise((resolve) => {
  const timer = setInterval(() => {
    const allDone = [...workers.values()].every(
      (state) => state.final !== undefined
    );
    if (allDone || Date.now() > deadline) {
      clearInterval(timer);
      resolve();
    }
  }, 100);
});

// Ensure all children exited; kill stragglers.
for (const state of workers.values()) {
  if (state.exitCode === undefined) {
    state.child.kill("SIGTERM");
  }
}
await new Promise((resolve) => setTimeout(resolve, 1000));

// --- Aggregation ---------------------------------------------------------------
const stats = [...workers.values()].map((state) => {
  const final = state.final ?? state.snapshots.at(-1);
  return {
    advanced:
      state.snapshots.length >= 2
        ? state.snapshots.at(-1).ops > state.snapshots[0].ops
        : (final?.ops ?? 0) > 0,
    crashed: state.exitCode !== 0,
    ops: final?.ops ?? 0,
    p50: final?.latencies.p50 ?? 0,
    p95: final?.latencies.p95 ?? 0,
    rssMb: final?.rssMb ?? 0,
  };
});
const totalOps = stats.reduce((sum, stat) => sum + stat.ops, 0);
const totalRssMb = stats.reduce((sum, stat) => sum + stat.rssMb, 0);
const elapsedSec = (Date.now() - startedAt) / 1000;

check(
  "capacity.allWorkersAdvanced",
  stats.every((stat) => stat.advanced),
  `${stats.filter((stat) => !stat.advanced).length} workers stalled`
);
check(
  "capacity.noWorkerCrashed",
  stats.every((stat) => !stat.crashed),
  `exit codes: ${[...workers.values()].map((state) => state.exitCode).join(",")}`
);
check(
  "capacity.totalOpsPositive",
  totalOps > 0,
  `${totalOps} ops across ${WORKERS} workers in ${elapsedSec.toFixed(1)}s`
);

console.log(
  JSON.stringify(
    {
      ...report,
      config: { durationMs: DURATION_MS, workers: WORKERS },
      perWorker: stats,
      totals: {
        avgOpsPerWorker: Math.round(totalOps / WORKERS),
        opsPerSecond: Math.round((totalOps / elapsedSec) * 10) / 10,
        totalOps,
        totalRssMb,
      },
    },
    null,
    2
  )
);
rmSync(dir, { force: true, recursive: true });
process.exit(report.assertions.every((assertion) => assertion.ok) ? 0 : 1);
