import assert from "node:assert/strict";
import test from "node:test";
import createExtension from "../index.js";
import { startDaemonHarness } from "./daemon-helpers.mjs";
import { createMockPi, delay, makeCtx, waitFor, withEnv } from "./helpers.mjs";

const SESSION_ID = "session-daemon-command";
const TEST_TIMEOUT_MS = 60_000;
const UNKNOWN_COMMAND_RE = /unknown_command_type/;

const ackFor = (daemon, requestId, status) =>
  daemon.acks.find(
    (entry) => entry.ack.requestId === requestId && entry.ack.status === status
  );

const waitForAck = (daemon, requestId, status, label) =>
  waitFor(() => ackFor(daemon, requestId, status), { label });

const startSession = async (daemon, ctx) => {
  await waitFor(
    () => daemon.service.executionState(SESSION_ID).generation === 1,
    { label: "generation 1" }
  );
  await waitFor(() => daemon.hasCommandSubscriber(SESSION_ID), {
    label: "command subscriber",
  });
  return ctx;
};

test("dispatches prompt and abort with truthful acks over the daemon channel", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const daemon = await startDaemonHarness();
  try {
    await withEnv(
      { OMO_DAEMON_SOCKET: daemon.socketPath, OMO_PI_VERSION: "0.86.1" },
      async () => {
        const state = { idle: true };
        const aborts = [];
        const { api, emit, sentUserMessages } = createMockPi();
        createExtension(api);
        const ctx = makeCtx({ sessionId: SESSION_ID });
        ctx.isIdle = () => state.idle;
        ctx.abort = () => aborts.push(Date.now());

        await emit("session_start", { type: "session_start" }, ctx);
        await startSession(daemon, ctx);

        // --- prompt: accepted -> started -> completed(reason) --------------
        assert.equal(
          daemon.sendCommand(SESSION_ID, {
            commandSequence: 1,
            requestId: "prompt-1",
            text: "hello daemon",
            type: "prompt",
          }),
          true
        );
        const accepted = await waitForAck(
          daemon,
          "prompt-1",
          "accepted",
          "prompt-1 accepted"
        );
        assert.equal(accepted.ack.generation, 1);
        assert.equal(sentUserMessages.length, 1);
        assert.equal(sentUserMessages[0].content, "hello daemon");

        await emit("agent_start", { type: "agent_start" }, ctx);
        await waitForAck(daemon, "prompt-1", "started", "prompt-1 started");
        await emit(
          "message_end",
          { message: { role: "assistant", stopReason: "stop" } },
          ctx
        );
        await emit("agent_settled", { type: "agent_settled" }, ctx);
        const completed = await waitForAck(
          daemon,
          "prompt-1",
          "completed",
          "prompt-1 completed"
        );
        assert.equal(completed.ack.reason, "stop");

        const acceptedIndex = daemon.acks.findIndex(
          (entry) =>
            entry.ack.requestId === "prompt-1" &&
            entry.ack.status === "accepted"
        );
        const startedIndex = daemon.acks.findIndex(
          (entry) =>
            entry.ack.requestId === "prompt-1" && entry.ack.status === "started"
        );
        const completedIndex = daemon.acks.findIndex(
          (entry) =>
            entry.ack.requestId === "prompt-1" &&
            entry.ack.status === "completed"
        );
        assert.ok(
          acceptedIndex < startedIndex && startedIndex < completedIndex,
          "accepted precedes started precedes completed"
        );

        // --- busy prompt is rejected without dispatching -------------------
        state.idle = false;
        daemon.sendCommand(SESSION_ID, {
          commandSequence: 2,
          requestId: "busy-1",
          text: "must not run",
          type: "prompt",
        });
        const busy = await waitForAck(
          daemon,
          "busy-1",
          "rejected",
          "busy-1 rejected"
        );
        assert.equal(busy.ack.reason, "turn_already_running");
        assert.equal(sentUserMessages.length, 1);

        // --- abort while a turn runs is accepted then completed ------------
        daemon.sendCommand(SESSION_ID, {
          commandSequence: 3,
          requestId: "abort-1",
          type: "abort",
        });
        await waitForAck(daemon, "abort-1", "accepted", "abort-1 accepted");
        assert.equal(aborts.length, 1);
        await emit(
          "message_end",
          { message: { role: "assistant", stopReason: "aborted" } },
          ctx
        );
        await emit("agent_settled", { type: "agent_settled" }, ctx);
        const abortCompleted = await waitForAck(
          daemon,
          "abort-1",
          "completed",
          "abort-1 completed"
        );
        assert.equal(abortCompleted.ack.reason, "aborted");

        // --- empty text, unknown type and duplicate requestId --------------
        state.idle = true;
        daemon.sendCommand(SESSION_ID, {
          commandSequence: 4,
          requestId: "empty-1",
          text: "   ",
          type: "prompt",
        });
        const empty = await waitForAck(
          daemon,
          "empty-1",
          "rejected",
          "empty-1 rejected"
        );
        assert.equal(empty.ack.reason, "empty_text");

        daemon.sendCommand(SESSION_ID, {
          commandSequence: 5,
          requestId: "unknown-1",
          type: "nonsense",
        });
        const unknown = await waitForAck(
          daemon,
          "unknown-1",
          "rejected",
          "unknown-1 rejected"
        );
        assert.match(unknown.ack.reason, UNKNOWN_COMMAND_RE);

        daemon.sendCommand(SESSION_ID, {
          commandSequence: 6,
          requestId: "prompt-1",
          text: "duplicate must not run",
          type: "prompt",
        });
        const duplicate = await waitForAck(
          daemon,
          "prompt-1",
          "rejected",
          "duplicate rejected"
        );
        assert.equal(duplicate.ack.reason, "duplicate_request");
        assert.equal(sentUserMessages.length, 1, "no second dispatch");

        // --- abort with no active turn is rejected -------------------------
        daemon.sendCommand(SESSION_ID, {
          commandSequence: 7,
          requestId: "abort-idle-1",
          type: "abort",
        });
        const abortIdle = await waitForAck(
          daemon,
          "abort-idle-1",
          "rejected",
          "idle abort rejected"
        );
        assert.equal(abortIdle.ack.reason, "no_active_turn");

        // --- malformed frames are dropped without crashing or acking -------
        const acksBefore = daemon.acks.length;
        assert.equal(
          daemon.sendRawCommand("{not valid json"),
          true,
          "raw frame written"
        );
        assert.equal(
          daemon.sendCommand(SESSION_ID, {
            requestId: "no-sequence",
            text: "x",
            type: "prompt",
          }),
          true
        );
        assert.equal(
          daemon.sendCommand(SESSION_ID, {
            commandSequence: 8,
            requestId: "prompt-missing-text",
            type: "prompt",
          }),
          true
        );
        await delay(300);
        assert.equal(
          daemon.acks.length,
          acksBefore,
          "malformed frames produce no ack"
        );

        // A valid command still works after malformed input.
        daemon.sendCommand(SESSION_ID, {
          commandSequence: 9,
          requestId: "prompt-2",
          text: "still alive",
          type: "prompt",
        });
        await waitForAck(daemon, "prompt-2", "accepted", "prompt-2 accepted");

        await emit(
          "session_shutdown",
          { reason: "quit", type: "session_shutdown" },
          ctx
        );
        await waitFor(
          () => daemon.service.executionState(SESSION_ID).state === "detached",
          { label: "detach" }
        );
      }
    );
  } finally {
    await daemon.close();
  }
});
