import assert from "node:assert/strict";
import test from "node:test";
import { startDaemonHarness } from "./daemon-helpers.mjs";
import { delay, EXTENSION_ENTRY, spawnPiRpc, waitFor } from "./helpers.mjs";

const PROMPT_ONE = "Reply with exactly: hello hello hello hello hello hello";
const PROMPT_TWO =
  "Write out the integers from 1 to 400, one per line, with no other text.";
const TEST_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 60_000;
const ACK_TIMEOUT_MS = 60_000;
const SETTLE_TIMEOUT_MS = 90_000;

const ackFor = (daemon, requestId, status) =>
  daemon.acks.find(
    (entry) => entry.ack.requestId === requestId && entry.ack.status === status
  );

const acksFor = (daemon, requestId, status) =>
  daemon.acks.filter(
    (entry) => entry.ack.requestId === requestId && entry.ack.status === status
  );

const forwarded = (daemon) =>
  daemon.nativeEvents.map((entry) => entry.event.event);

const countForwarded = (daemon, eventName) =>
  daemon.nativeEvents.filter((entry) => entry.event.event === eventName).length;

const countUserMessages = (daemon) =>
  daemon.nativeEvents.filter(
    (entry) =>
      entry.event.event === "message_start" &&
      entry.event.payload?.message?.role === "user"
  ).length;

const textDeltas = (daemon, sinceIndex = 0) =>
  daemon.nativeEvents
    .slice(sinceIndex)
    .filter((entry) => entry.event.event === "message_update")
    .map((entry) => entry.event.payload?.assistantMessageEvent)
    .filter(
      (delta) =>
        delta?.type === "text_delta" &&
        typeof delta.delta === "string" &&
        delta.delta.length > 0
    );

test("dispatches daemon commands into the live native session with structured acks", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const daemon = await startDaemonHarness();
  const pi = spawnPiRpc({
    args: ["--extension", EXTENSION_ENTRY],
    env: { OMO_DAEMON_SOCKET: daemon.socketPath, OMO_PI_VERSION: "0.85.0" },
  });
  const context = () =>
    `\nstderr:\n${pi.stderr}\nacks=[${daemon.acks
      .map((entry) => `${entry.ack.requestId}:${entry.ack.status}`)
      .join(", ")}]\n`;

  try {
    await waitFor(() => daemon.registerCalls.length === 1, {
      label: "extension register",
      timeout: READY_TIMEOUT_MS,
    });
    const { sessionId } = daemon.registerCalls[0];
    await waitFor(() => daemon.hasCommandSubscriber(sessionId), {
      label: "outbound command stream",
      timeout: READY_TIMEOUT_MS,
    });

    // --- Prompt: accepted -> started -> deltas -> completed(stop) ---------
    daemon.sendCommand(sessionId, {
      commandSequence: 1,
      requestId: "prompt-1",
      text: PROMPT_ONE,
      type: "prompt",
    });
    await waitFor(() => ackFor(daemon, "prompt-1", "accepted"), {
      label: "prompt-1 accepted ack",
      timeout: ACK_TIMEOUT_MS,
    });
    await waitFor(() => ackFor(daemon, "prompt-1", "started"), {
      label: "prompt-1 started ack",
      timeout: ACK_TIMEOUT_MS,
    });
    await waitFor(() => textDeltas(daemon).length >= 2, {
      label: "streaming deltas for prompt-1",
      timeout: ACK_TIMEOUT_MS,
    });
    const completed = await waitFor(
      () => ackFor(daemon, "prompt-1", "completed"),
      { label: "prompt-1 completed ack", timeout: SETTLE_TIMEOUT_MS }
    );
    assert.equal(
      completed.ack.reason,
      "stop",
      `native stop reason is reported${context()}`
    );
    assert.equal(completed.ack.generation, 1);
    assert.equal(completed.ack.instanceId, daemon.registerCalls[0].instanceId);

    const acceptedSeq = daemon.acks.findIndex(
      (entry) =>
        entry.ack.requestId === "prompt-1" && entry.ack.status === "accepted"
    );
    const startedSeq = daemon.acks.findIndex(
      (entry) =>
        entry.ack.requestId === "prompt-1" && entry.ack.status === "started"
    );
    const completedSeq = daemon.acks.findIndex(
      (entry) =>
        entry.ack.requestId === "prompt-1" && entry.ack.status === "completed"
    );
    assert.ok(
      acceptedSeq < startedSeq && startedSeq < completedSeq,
      `accepted precedes started precedes completed${context()}`
    );
    assert.ok(
      forwarded(daemon).includes("session_start"),
      `session_start forwarded${context()}`
    );

    // --- Duplicate requestId must not execute twice ------------------------
    const agentStartsBefore = countForwarded(daemon, "agent_start");
    const userMessagesBefore = countUserMessages(daemon);
    daemon.sendCommand(sessionId, {
      commandSequence: 2,
      requestId: "prompt-1",
      text: "this duplicate must never run",
      type: "prompt",
    });
    const duplicate = await waitFor(
      () => ackFor(daemon, "prompt-1", "rejected"),
      { label: "duplicate requestId rejected", timeout: ACK_TIMEOUT_MS }
    );
    assert.equal(
      duplicate.ack.reason,
      "duplicate_request",
      `duplicate reason${context()}`
    );
    await delay(1500);
    assert.equal(
      countForwarded(daemon, "agent_start"),
      agentStartsBefore,
      `duplicate prompt did not start a run${context()}`
    );
    assert.equal(
      countUserMessages(daemon),
      userMessagesBefore,
      `duplicate prompt did not add a user message${context()}`
    );

    // --- Long prompt + mid-stream abort -----------------------------------
    const mark = daemon.nativeEvents.length;
    daemon.sendCommand(sessionId, {
      commandSequence: 3,
      requestId: "prompt-2",
      text: PROMPT_TWO,
      type: "prompt",
    });
    await waitFor(() => ackFor(daemon, "prompt-2", "accepted"), {
      label: "prompt-2 accepted ack",
      timeout: ACK_TIMEOUT_MS,
    });
    await waitFor(() => ackFor(daemon, "prompt-2", "started"), {
      label: "prompt-2 started ack",
      timeout: ACK_TIMEOUT_MS,
    });
    await waitFor(() => textDeltas(daemon, mark).length >= 1, {
      label: "prompt-2 streaming deltas",
      timeout: ACK_TIMEOUT_MS,
    });
    assert.equal(
      ackFor(daemon, "prompt-2", "completed"),
      undefined,
      `prompt-2 still streaming before abort${context()}`
    );

    daemon.sendCommand(sessionId, {
      commandSequence: 4,
      requestId: "abort-1",
      type: "abort",
    });
    await waitFor(() => ackFor(daemon, "abort-1", "accepted"), {
      label: "abort accepted ack",
      timeout: ACK_TIMEOUT_MS,
    });
    await waitFor(() => ackFor(daemon, "prompt-2", "completed"), {
      label: "prompt-2 completed after abort",
      timeout: SETTLE_TIMEOUT_MS,
    });
    const abortCompleted = await waitFor(
      () => ackFor(daemon, "abort-1", "completed"),
      { label: "abort completed ack", timeout: SETTLE_TIMEOUT_MS }
    );
    assert.equal(
      abortCompleted.ack.reason,
      "aborted",
      `abort completion reports the native stop reason${context()}`
    );
    const abortAcceptedIndex = daemon.acks.findIndex(
      (entry) =>
        entry.ack.requestId === "abort-1" && entry.ack.status === "accepted"
    );
    const promptTwoCompletedIndex = daemon.acks.findIndex(
      (entry) =>
        entry.ack.requestId === "prompt-2" && entry.ack.status === "completed"
    );
    const abortCompletedIndex = daemon.acks.findIndex(
      (entry) =>
        entry.ack.requestId === "abort-1" && entry.ack.status === "completed"
    );
    assert.ok(
      abortAcceptedIndex < promptTwoCompletedIndex &&
        promptTwoCompletedIndex < abortCompletedIndex,
      `abort accepted precedes prompt-2 completion precedes abort completion${context()}`
    );
    assert.ok(
      forwarded(daemon)
        .slice(mark)
        .some((event) => event === "turn_end" || event === "agent_end"),
      `turn/agent end observed after abort${context()}`
    );
    assert.ok(
      daemon.nativeEvents.some(
        (entry) =>
          entry.event.event === "message_end" &&
          entry.event.payload?.message?.role === "assistant" &&
          entry.event.payload.message.stopReason === "aborted"
      ),
      `native runtime reports an aborted assistant message${context()}`
    );
    assert.equal(
      acksFor(daemon, "prompt-1", "completed").length,
      1,
      "prompt-1 completes exactly once"
    );

    await pi.stop();
    await waitFor(
      () => daemon.service.executionState(sessionId).state === "detached",
      { label: "detach after RPC shutdown", timeout: 30_000 }
    );
  } finally {
    await pi.stop();
    await daemon.close();
  }
});
