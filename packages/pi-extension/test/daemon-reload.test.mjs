import assert from "node:assert/strict";
import test from "node:test";
import createExtension from "../index.js";
import { startDaemonHarness } from "./daemon-helpers.mjs";
import { createMockPi, delay, makeCtx, waitFor, withEnv } from "./helpers.mjs";

const SESSION_ID = "session-reload";
const TEST_TIMEOUT_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 1000;

test("sequential extension reloads do not double-register, double-forward or leak resources", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const daemon = await startDaemonHarness({
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: 15_000,
  });
  try {
    await withEnv(
      { OMO_DAEMON_SOCKET: daemon.socketPath, OMO_PI_VERSION: "0.85.0" },
      async () => {
        // One shared mock `pi`; each `createExtension` call is one module load
        // (Pi re-imports the module on `/reload`).
        const { api, emit } = createMockPi();
        const ctx = makeCtx({ sessionId: SESSION_ID });

        // --- first load ----------------------------------------------------
        createExtension(api);
        await emit(
          "session_start",
          { reason: "startup", type: "session_start" },
          ctx
        );
        await waitFor(
          () => daemon.service.executionState(SESSION_ID).generation === 1,
          { label: "first load generation 1" }
        );
        await waitFor(() => daemon.hasCommandSubscriber(SESSION_ID), {
          label: "first load command subscriber",
        });
        await emit(
          "session_shutdown",
          { reason: "reload", type: "session_shutdown" },
          ctx
        );
        await waitFor(
          () => daemon.service.executionState(SESSION_ID).state === "detached",
          { label: "first load detached" }
        );
        assert.equal(daemon.registerCalls.length, 1);

        // --- second load (same shared pi) ---------------------------------
        createExtension(api);
        await emit(
          "session_start",
          { reason: "reload", type: "session_start" },
          ctx
        );
        await waitFor(
          () => daemon.service.executionState(SESSION_ID).generation === 2,
          { label: "second load generation 2" }
        );
        await waitFor(() => daemon.hasCommandSubscriber(SESSION_ID), {
          label: "second load command subscriber",
        });
        // The superseded first instance must not have re-registered.
        assert.equal(
          daemon.registerCalls.length,
          2,
          "exactly one register per reload"
        );

        // --- one native event, exactly one forwarded batch ----------------
        const eventsBefore = daemon.nativeEvents.length;
        const batchesBefore = daemon.eventBatches.length;
        await emit("message_update", { type: "message_update" }, ctx);
        await waitFor(() => daemon.nativeEvents.length === eventsBefore + 1, {
          label: "single forwarded event",
        });
        await delay(300);
        assert.equal(
          daemon.nativeEvents.length,
          eventsBefore + 1,
          "no doubled native event after reload"
        );
        assert.equal(
          daemon.eventBatches.length,
          batchesBefore + 1,
          "no doubled event batch after reload"
        );

        // --- both (already superseded) loads shut down --------------------
        await emit(
          "session_shutdown",
          { reason: "reload", type: "session_shutdown" },
          ctx
        );
        await waitFor(
          () => daemon.service.executionState(SESSION_ID).state === "detached",
          { label: "second load detached" }
        );

        // No leaked heartbeat timer or command stream after both shutdowns.
        const requestsAfterShutdown = daemon.requests.length;
        await delay(HEARTBEAT_INTERVAL_MS + 600);
        assert.equal(
          daemon.requests.length,
          requestsAfterShutdown,
          `no requests after shutdown: ${JSON.stringify(
            daemon.requests.slice(requestsAfterShutdown)
          )}`
        );
      }
    );
  } finally {
    await daemon.close();
  }
});
