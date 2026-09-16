import assert from "node:assert/strict";
import test from "node:test";
import createExtension from "../index.js";
import { startDaemonHarness } from "./daemon-helpers.mjs";
import { createMockPi, makeCtx, waitFor, withEnv } from "./helpers.mjs";

const SESSION_ID = "session-daemon-fencing";
const TEST_TIMEOUT_MS = 60_000;

const ackFor = (daemon, requestId, status) =>
  daemon.acks.find(
    (entry) => entry.ack.requestId === requestId && entry.ack.status === status
  );

test("a daemon-side generation change fences old commands and acks", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const clock = { value: Date.now() };
  const daemon = await startDaemonHarness({
    heartbeatIntervalMs: 1000,
    heartbeatTimeoutMs: 5000,
    now: () => clock.value,
    sweepIntervalMs: 50,
  });
  try {
    await withEnv(
      { OMO_DAEMON_SOCKET: daemon.socketPath, OMO_PI_VERSION: "0.85.0" },
      async () => {
        const { api, emit } = createMockPi();
        createExtension(api);
        const ctx = makeCtx({ sessionId: SESSION_ID });
        ctx.isIdle = () => true;

        await emit("session_start", { type: "session_start" }, ctx);
        await waitFor(
          () => daemon.service.executionState(SESSION_ID).generation === 1,
          { label: "generation 1" }
        );
        await waitFor(() => daemon.hasCommandSubscriber(SESSION_ID), {
          label: "generation-1 command subscriber",
        });

        // A command accepted under generation 1 (its accepted ack is in flight
        // state that must be dropped once the generation dies).
        daemon.sendCommand(SESSION_ID, {
          commandSequence: 1,
          requestId: "prompt-gen1",
          text: "generation one",
          type: "prompt",
        });
        await waitFor(() => ackFor(daemon, "prompt-gen1", "accepted"), {
          label: "generation-1 accepted ack",
        });
        const { instanceId } = daemon.registerCalls[0];

        // Expire the lease; the heartbeat is answered 409 and the extension
        // re-registers with a fresh generation.
        clock.value += 60_000;
        await waitFor(
          () => daemon.service.executionState(SESSION_ID).generation === 2,
          { label: "generation 2 after re-register", timeout: 30_000 }
        );
        await waitFor(() => daemon.hasCommandSubscriber(SESSION_ID), {
          label: "generation-2 command subscriber",
        });

        // The old in-flight prompt must never be relabelled: a native settle
        // now produces no completed ack for generation 1.
        await emit(
          "message_end",
          { message: { role: "assistant", stopReason: "stop" } },
          ctx
        );
        await emit("agent_settled", { type: "agent_settled" }, ctx);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(
          ackFor(daemon, "prompt-gen1", "completed"),
          undefined,
          "old-generation completion is dropped"
        );

        // The daemon rejects an old-generation ack deterministically (409).
        await assert.rejects(
          () =>
            daemon.service.ack(
              {
                commandSequence: 1,
                generation: 1,
                instanceId,
                requestId: "stale-ack",
                status: "completed",
              },
              "stale-credential"
            ),
          (error) => error.status === 409,
          "stale generation ack is rejected with 409"
        );

        // Command sequence numbering restarts per generation: sequence 1 on
        // the new stream is accepted and acked with generation 2.
        const acksBeforeNew = daemon.acks.length;
        daemon.sendCommand(SESSION_ID, {
          commandSequence: 1,
          requestId: "prompt-gen2",
          text: "generation two",
          type: "prompt",
        });
        const accepted = await waitFor(
          () => ackFor(daemon, "prompt-gen2", "accepted"),
          { label: "generation-2 accepted ack" }
        );
        assert.equal(accepted.ack.generation, 2);
        const newAcks = daemon.acks.slice(acksBeforeNew);
        assert.ok(
          newAcks.every((entry) => entry.ack.generation === 2),
          "no ack is sent under the stale generation after re-register"
        );

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
