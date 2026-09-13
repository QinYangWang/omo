/**
 * P0 experiment 3 — receipt reconciliation under crash injection (plan §5.4,
 * §5.8, §13 P0 交付 7; §14 受理/掉电类别).
 *
 * The PARENT process is the independent receipt recorder (an external client
 * stand-in): it appends every receipt it actually receives to an ndjson log
 * with fsync. The CHILD process is a disposable daemon hosting the durable
 * command inbox. The parent injects SIGKILL crashes:
 *   - random kills between commands;
 *   - deliberate kills inside the reply window (commit done, reply lost) via
 *     "receiveAndDie";
 *   - client retries after each crash replay the ORIGINAL command identity
 *     (same mutation id + payload), never a fresh id (§4.3 对账规则).
 *
 * Final reconciliation invariants:
 *   R1 every recorded receipt has a durable row with the same commandId and
 *      inboxSeq (no phantom confirmations);
 *   R2 rows committed without a receipt (reply-window crashes) are recovered
 *      by replaying the same mutation, returning the ORIGINAL receipt;
 *   R3 no duplicate rows exist for replayed mutations.
 *
 * Limitations (recorded in docs/v2-upstream-verification.md): SIGKILL does
 * not clear the OS page cache; controlled power-loss validation across the
 * three platforms remains a separate procedure (§5.8).
 *
 * Run: node --no-warnings experiments/p0/durability-receipts.mjs
 */
import { fork } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TOTAL_COMMANDS = 240;
const KILL_EVERY = 37; // random-ish periodic background kills
const DIE_REPLY_WINDOW_EVERY = 53; // deliberate commit-then-die windows

const report = { assertions: [], ok: true };
const check = (name, condition, detail = "") => {
  report.assertions.push({ detail, name, ok: condition });
  if (!condition) {
    report.ok = false;
  }
};

const dir = mkdtempSync(join(tmpdir(), "omo-p0-receipts-"));
const daemonPath = fileURLToPath(
  new URL("./helpers/inbox-daemon.mjs", import.meta.url)
);
const inboxDb = join(dir, "inbox.sqlite");
const receiptLog = join(dir, "receipts.ndjson");
const scope = {
  laneId: "main",
  sessionId: "ses_receipts",
  workspaceId: "wks_receipts",
};

/** Append one receipt line and fsync before continuing (external recorder). */
const recordReceipt = (receipt) => {
  const fd = openSync(receiptLog, "a");
  try {
    writeSync(fd, `${JSON.stringify(receipt)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const spawnDaemon = () =>
  fork(daemonPath, [inboxDb], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });

const request = (child, message) =>
  new Promise((resolve, reject) => {
    const onMessage = (reply) => {
      cleanup();
      resolve(reply);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`daemon exited (${code ?? signal})`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
    child.send(message);
  });

const waitReady = (child) =>
  new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type === "ready") {
        child.off("message", onMessage);
        resolve();
      }
    };
    child.on("message", onMessage);
    child.once("exit", () => reject(new Error("daemon exited before ready")));
  });

const swallowExit = () => undefined;

let daemon = spawnDaemon();
await waitReady(daemon);

const kills = { background: 0, replyWindow: 0 };
const replaysAfterCrash = [];

// Commands are sent strictly one at a time: the receipt stream must stay
// ordered for reconciliation to be meaningful.
for (let index = 1; index <= TOTAL_COMMANDS; index += 1) {
  const mutation = `mut_${index}`;
  const command = {
    clientMutationId: mutation,
    commandId: `cmd_${mutation}`,
    kind: "session.prompt",
    operationId: `op_${mutation}`,
    payload: { index, text: `work item ${index}` },
    scope,
  };

  if (index % DIE_REPLY_WINDOW_EVERY === 0) {
    // Crash inside the reply window: the commit lands, the reply never does.
    kills.replyWindow += 1;
    // biome-ignore lint/performance/noAwaitInLoops: ordered command stream by design
    await request(daemon, { command, type: "receiveAndDie" }).catch(
      swallowExit
    );
    daemon = spawnDaemon();
    await waitReady(daemon);
    // Client retry: SAME identity, same payload — never a fresh id.
    const replay = await request(daemon, { command, type: "receive" });
    recordReceipt(replay.receipt);
    replaysAfterCrash.push({ command, replay: replay.receipt });
    continue;
  }

  try {
    const reply = await request(daemon, { command, type: "receive" });
    recordReceipt(reply.receipt);
  } catch {
    // Daemon died before replying (unknown whether the commit landed).
    // Fall through: the crash-recovery replay below settles the truth.
  }

  if (index % KILL_EVERY === 0) {
    kills.background += 1;
    daemon.kill("SIGKILL");
    daemon = spawnDaemon();
    await waitReady(daemon);
    // Reconcile the possibly-lost command by replaying its identity.
    const replay = await request(daemon, { command, type: "receive" });
    recordReceipt(replay.receipt);
    replaysAfterCrash.push({ command, replay: replay.receipt });
  }
}

// Final durable state.
const dump = await request(daemon, { scope, type: "dump" });
daemon.kill("SIGKILL");

// --- Reconciliation ----------------------------------------------------------
const durableByCommandId = new Map(
  dump.records.map((record) => [record.commandId, record])
);
const receiptLines = readFileSync(receiptLog, "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line));

// R1: every recorded receipt exists durably with identical identity.
const phantom = receiptLines.filter((receipt) => {
  const row = durableByCommandId.get(receipt.commandId);
  return !row || row.inboxSeq !== receipt.inboxSeq;
});
check(
  "R1.noPhantomReceipts",
  phantom.length === 0,
  `${phantom.length} receipts lack a matching durable row`
);

// R2: reply-window replays returned the ORIGINAL command identity.
const badReplay = replaysAfterCrash.filter(
  ({ command, replay }) => replay.commandId !== command.commandId
);
check(
  "R2.crashReplayReturnsOriginalReceipt",
  badReplay.length === 0 && replaysAfterCrash.length > 0,
  `${replaysAfterCrash.length} crash replays, ${badReplay.length} mismatched`
);

// R3: no duplicate durable rows for any mutation (one row per commandId already
// enforced by UNIQUE; here: replay never created cmd_-prefixed duplicates).
check(
  "R3.noDuplicateRows",
  dump.records.length === TOTAL_COMMANDS,
  `durable rows=${dump.records.length}, expected=${TOTAL_COMMANDS}`
);

check(
  "coverage.crashesInjected",
  kills.background > 0 && kills.replyWindow > 0,
  JSON.stringify(kills)
);
check(
  "coverage.receiptsRecorded",
  receiptLines.length >= TOTAL_COMMANDS,
  `receipts=${receiptLines.length} commands=${TOTAL_COMMANDS}`
);

console.log(
  JSON.stringify(
    {
      ...report,
      durableRows: dump.records.length,
      kills,
      receipts: receiptLines.length,
    },
    null,
    2
  )
);
rmSync(dir, { force: true, recursive: true });
process.exit(report.assertions.every((assertion) => assertion.ok) ? 0 : 1);
