import assert from "node:assert/strict";
import test from "node:test";
import createExtension from "../index.js";
import { startDaemonHarness } from "./daemon-helpers.mjs";
import { createMockPi, makeCtx, waitFor, withEnv } from "./helpers.mjs";

const TEST_TIMEOUT_MS = 120_000;
const REASONS = ["new", "resume", "fork"];

/**
 * Simulates Pi's session replacement lifecycle for one reason: the old session
 * shuts down (fully detaching its attachment) before the new `session_start`
 * registers with the new `sessionId`/`sessionFile`.
 */
async function assertSwitch(daemon, emit, sentUserMessages, reason) {
  const oldId = `session-old-${reason}`;
  const newId = `session-new-${reason}`;
  const oldState = { idleCalls: 0 };
  const oldCtx = makeCtx({ sessionId: oldId });
  oldCtx.isIdle = () => {
    oldState.idleCalls += 1;
    return true;
  };
  oldCtx.abort = () => undefined;

  await emit(
    "session_start",
    { reason: "startup", type: "session_start" },
    oldCtx
  );
  await waitFor(() => daemon.service.executionState(oldId).generation === 1, {
    label: `${reason}: old generation 1`,
  });
  await waitFor(() => daemon.hasCommandSubscriber(oldId), {
    label: `${reason}: old command subscriber`,
  });

  const detachesBefore = daemon.detaches.length;
  await emit("session_shutdown", { reason, type: "session_shutdown" }, oldCtx);
  await waitFor(
    () => daemon.service.executionState(oldId).state === "detached",
    { label: `${reason}: old detached` }
  );
  assert.equal(
    daemon.detaches.length,
    detachesBefore + 1,
    `${reason}: exactly one detach for the old session`
  );
  const [detach] = daemon.detaches.slice(-1);
  assert.equal(detach.sessionId, oldId);
  assert.equal(detach.reason, "session_shutdown");

  const eventsAfterShutdown = daemon.nativeEvents.length;

  // --- switch to the new session ---------------------------------------
  const newState = { idleCalls: 0 };
  const newCtx = makeCtx({
    sessionFile: `/tmp/${newId}.jsonl`,
    sessionId: newId,
  });
  newCtx.isIdle = () => {
    newState.idleCalls += 1;
    return true;
  };
  const sentBefore = sentUserMessages.length;
  await emit(
    "session_start",
    {
      previousSessionFile: `/tmp/${oldId}.jsonl`,
      reason,
      type: "session_start",
    },
    newCtx
  );
  await waitFor(() => daemon.service.executionState(newId).generation === 1, {
    label: `${reason}: new generation 1`,
  });
  await waitFor(() => daemon.hasCommandSubscriber(newId), {
    label: `${reason}: new command subscriber`,
  });
  const registration = daemon.registerCalls.at(-1);
  assert.equal(registration.sessionId, newId);
  assert.equal(registration.sessionFile, `/tmp/${newId}.jsonl`);
  assert.equal(
    daemon.service.executionState(oldId).state,
    "detached",
    `${reason}: old session stays detached`
  );

  // A prompt for the new session must resolve the new live ctx, not a stale
  // captured one.
  daemon.sendCommand(newId, {
    commandSequence: 1,
    requestId: `${reason}-prompt`,
    text: `hello ${reason}`,
    type: "prompt",
  });
  await waitFor(
    () =>
      daemon.acks.find(
        (entry) =>
          entry.ack.requestId === `${reason}-prompt` &&
          entry.ack.status === "accepted"
      ),
    { label: `${reason}: prompt accepted` }
  );
  assert.ok(
    newState.idleCalls >= 1,
    `${reason}: dispatch consulted the new ctx`
  );
  assert.equal(
    oldState.idleCalls,
    0,
    `${reason}: dispatch never touched the stale old ctx`
  );
  assert.equal(sentUserMessages.length, sentBefore + 1);
  assert.equal(sentUserMessages.at(-1).content, `hello ${reason}`);

  // No event after the old shutdown references the old session.
  const lateOldEvents = daemon.nativeEvents
    .slice(eventsAfterShutdown)
    .filter((entry) => entry.event.sessionId === oldId);
  assert.equal(
    lateOldEvents.length,
    0,
    `${reason}: zero old-session events after shutdown`
  );

  // Finish the new turn and shut the new session down.
  await emit("agent_start", { type: "agent_start" }, newCtx);
  await emit(
    "message_end",
    { message: { role: "assistant", stopReason: "stop" } },
    newCtx
  );
  await emit("agent_settled", { type: "agent_settled" }, newCtx);
  await emit("session_shutdown", { reason, type: "session_shutdown" }, newCtx);
  await waitFor(
    () => daemon.service.executionState(newId).state === "detached",
    { label: `${reason}: new detached` }
  );
}

test("session switches dispose the old attachment before registering the new session", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const daemon = await startDaemonHarness();
  try {
    await withEnv(
      { OMO_DAEMON_SOCKET: daemon.socketPath, OMO_PI_VERSION: "0.86.1" },
      async () => {
        const { api, emit, sentUserMessages } = createMockPi();
        createExtension(api);
        // Sequential: each switch must fully replace the previous attachment.
        await REASONS.reduce(
          (previous, reason) =>
            previous.then(() =>
              assertSwitch(daemon, emit, sentUserMessages, reason)
            ),
          Promise.resolve()
        );
        // Each switch produced a fresh registration for exactly one instance.
        assert.equal(daemon.registerCalls.length, REASONS.length * 2);
      }
    );
  } finally {
    await daemon.close();
  }
});
