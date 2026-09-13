/**
 * P0 capacity experiment — one Session Worker process (plan §4.1, §8.1).
 *
 * Each worker owns ONE root session in its own directory on its own
 * WAL + FULL database, and continuously accepts + drives fixed-id prompt
 * operations against a faux provider. Progress is reported over IPC so the
 * parent can prove every process keeps advancing (not just stays alive).
 *
 * usage: session-worker.mjs <workerId> <baseDir> <durationMs>
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CoreHarnessRuntime } from "@omo/agent-runtime/core-runtime";
import { createFauxModels } from "@omo/agent-runtime/testing";

const [workerId, baseDir, durationArg] = process.argv.slice(2);
const durationMs = Number(durationArg ?? "15000");

const dir = join(baseDir, `worker-${workerId}`);
mkdirSync(dir, { recursive: true });

const { faux, model, models } = createFauxModels();
const runtime = CoreHarnessRuntime.create({ directory: dir, model, models });
const session = await runtime.createSession(`worker-${workerId}`);

const latencies = [];
let ops = 0;
let failed = 0;
const startedAt = Date.now();
const stopAt = startedAt + durationMs;

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ];
};

const reportProgress = (final = false) => {
  process.send?.({
    failed,
    final,
    latencies: {
      max: Math.max(...latencies),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
    },
    ops,
    rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    type: "progress",
    workerId,
  });
  latencies.length = 0;
};

// The worker drives one operation at a time: lane semantics are serial.
while (Date.now() < stopAt) {
  const operationId = `op_w${workerId}_${ops}`;
  faux.appendResponses([fauxAssistantMessage(`worker ${workerId} op ${ops}`)]);
  // biome-ignore lint/performance/noAwaitInLoops: serial lane execution by design
  const admission = await session.accept({
    kind: "prompt",
    operationId,
    prompt: `iteration ${ops}`,
  });
  if (!admission.ok) {
    failed += 1;
    continue;
  }
  const driveStart = performance.now();
  const driven = await session.drive(operationId);
  latencies.push(performance.now() - driveStart);
  if (
    driven.ok &&
    driven.value.kind === "settled" &&
    driven.value.result.status === "completed"
  ) {
    ops += 1;
  } else {
    failed += 1;
  }
  if (ops % 10 === 0) {
    reportProgress();
  }
}

reportProgress(true);
await session.close();
await runtime.close();
process.exit(0);
