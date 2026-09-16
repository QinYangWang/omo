import assert from "node:assert/strict";
import test from "node:test";
import createExtension from "../index.js";
import { startDaemonHarness } from "./daemon-helpers.mjs";
import { createMockPi, makeCtx, waitFor, withEnv } from "./helpers.mjs";

const SESSION_ID = "session-recovery";
const TEST_TIMEOUT_MS = 60_000;

const hasNativeEvent = (daemon, eventName, generation) =>
  daemon.nativeEvents.some(
    (entry) =>
      entry.event.event === eventName &&
      entry.attachment.generation === generation
  );

test("heartbeat expiry triggers one bounded re-register and forwarding resumes", {
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

        await emit(
          "session_start",
          { reason: "startup", type: "session_start" },
          ctx
        );
        await waitFor(
          () => daemon.service.executionState(SESSION_ID).generation === 1,
          { label: "generation 1" }
        );
        await emit("message_update", { type: "message_update" }, ctx);
        await waitFor(() => hasNativeEvent(daemon, "message_update", 1), {
          label: "generation-1 message_update",
        });

        // Expire the daemon-side lease while the extension still believes it
        // is attached. The next heartbeat is answered with a 409.
        clock.value += 60_000;

        await waitFor(
          () => daemon.service.executionState(SESSION_ID).generation === 2,
          { label: "generation 2 after re-register", timeout: 30_000 }
        );
        assert.ok(
          daemon.registerCalls.length >= 2,
          "the bounded re-register path ran"
        );

        // Forwarding resumes under the new generation.
        await emit("message_update", { type: "message_update" }, ctx);
        await waitFor(() => hasNativeEvent(daemon, "message_update", 2), {
          label: "generation-2 message_update",
        });

        await emit(
          "session_shutdown",
          { reason: "quit", type: "session_shutdown" },
          ctx
        );
        await waitFor(
          () => daemon.service.executionState(SESSION_ID).state === "detached",
          { label: "detach after shutdown" }
        );
      }
    );
  } finally {
    await daemon.close();
  }
});
