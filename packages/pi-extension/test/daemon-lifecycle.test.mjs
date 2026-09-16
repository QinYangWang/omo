import assert from "node:assert/strict";
import test from "node:test";
import createExtension from "../index.js";
import { startDaemonHarness } from "./daemon-helpers.mjs";
import { createMockPi, delay, makeCtx, waitFor, withEnv } from "./helpers.mjs";

const SESSION_ID = "session-daemon-lifecycle";
const TEST_TIMEOUT_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 1000;

test("daemon attachment lifecycle is idempotent and re-registers with a new generation", {
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
        const { api, emit } = createMockPi();
        createExtension(api);
        const ctx = makeCtx({ sessionId: SESSION_ID });
        const state = () => daemon.service.executionState(SESSION_ID);

        await emit("session_start", { type: "session_start" }, ctx);
        await waitFor(() => state().generation === 1, {
          label: "generation 1",
        });
        await emit("session_shutdown", { type: "session_shutdown" }, ctx);
        await waitFor(() => state().state === "detached", {
          label: "first detach",
        });

        const detachesAfterFirst = daemon.detaches.length;
        const requestsAfterFirst = daemon.requests.length;

        // Double shutdown must be a no-op.
        await emit("session_shutdown", { type: "session_shutdown" }, ctx);
        // Wait longer than one heartbeat interval to prove no timer leaked
        // past shutdown.
        await delay(HEARTBEAT_INTERVAL_MS + 300);
        assert.equal(
          daemon.detaches.length,
          detachesAfterFirst,
          "double shutdown does not detach again"
        );
        assert.equal(
          daemon.requests.length,
          requestsAfterFirst,
          `no requests after shutdown: ${JSON.stringify(
            daemon.requests.slice(requestsAfterFirst)
          )}`
        );

        // A second session_start registers again with a new generation.
        await emit("session_start", { type: "session_start" }, ctx);
        await waitFor(() => state().generation === 2, {
          label: "generation 2",
        });
        await emit("session_shutdown", { type: "session_shutdown" }, ctx);
        await waitFor(() => state().state === "detached", {
          label: "second detach",
        });
      }
    );
  } finally {
    await daemon.close();
  }
});
