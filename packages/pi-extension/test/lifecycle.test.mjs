import assert from "node:assert/strict";
import test from "node:test";
import createExtension from "../index.js";
import {
  createMockPi,
  delay,
  makeCtx,
  startReceiver,
  waitFor,
  withEnv,
} from "./helpers.mjs";

const eventsFor = (received, name) =>
  received.filter((record) => record.event === name);

test("spike session resources are created on session_start and released idempotently", async () => {
  const receiver = await startReceiver();
  try {
    await withEnv(
      {
        OMO_EXTENSION_COMMANDS_URL: receiver.url.commands,
        OMO_EXTENSION_EVENTS_URL: receiver.url.events,
      },
      async () => {
        const { api, emit } = createMockPi();
        createExtension(api);

        // --- First session ------------------------------------------------
        await emit(
          "session_start",
          { reason: "startup", type: "session_start" },
          makeCtx({ sessionId: "session-one" })
        );
        await waitFor(
          () => eventsFor(receiver.received, "session_start").length === 1,
          { label: "first session_start" }
        );
        assert.equal(receiver.hasCommandClient(), true);

        await emit(
          "message_update",
          { type: "message_update" },
          makeCtx({ sessionId: "session-one" })
        );
        await waitFor(
          () => eventsFor(receiver.received, "message_update").length === 1,
          { label: "first message_update" }
        );

        await emit(
          "session_shutdown",
          { reason: "new", type: "session_shutdown" },
          makeCtx({ sessionId: "session-one" })
        );
        await waitFor(
          () => eventsFor(receiver.received, "session_shutdown").length === 1,
          { label: "first session_shutdown" }
        );

        // Double shutdown is a no-op: no throw, no extra work.
        await emit(
          "session_shutdown",
          { reason: "new", type: "session_shutdown" },
          makeCtx({ sessionId: "session-one" })
        );

        const afterFirstShutdown = receiver.received.length;
        await delay(300);
        assert.equal(
          receiver.received.length,
          afterFirstShutdown,
          "no requests are emitted after session_shutdown"
        );

        // --- Second session ----------------------------------------------
        await emit(
          "session_start",
          { reason: "new", type: "session_start" },
          makeCtx({ sessionId: "session-two" })
        );
        await waitFor(
          () => eventsFor(receiver.received, "session_start").length === 2,
          { label: "second session_start" }
        );
        await emit(
          "session_shutdown",
          { reason: "quit", type: "session_shutdown" },
          makeCtx({ sessionId: "session-two" })
        );
        await waitFor(
          () => eventsFor(receiver.received, "session_shutdown").length === 2,
          { label: "second session_shutdown" }
        );

        // nativeSequence stays process-scoped and monotonic across sessions.
        const sequences = receiver.received.map(
          (record) => record.nativeSequence
        );
        assert.equal(Math.min(...sequences), 1);
        for (let index = 1; index < sequences.length; index += 1) {
          assert.ok(
            sequences[index] > sequences[index - 1],
            `nativeSequence increases at ${index}`
          );
        }
      }
    );
  } finally {
    await receiver.close();
  }
});

test("events-only configuration stays inert until session_start and cleans up on shutdown", async () => {
  const receiver = await startReceiver();
  try {
    await withEnv(
      {
        OMO_EXTENSION_COMMANDS_URL: undefined,
        OMO_EXTENSION_EVENTS_URL: receiver.url.events,
      },
      async () => {
        const { api, emit } = createMockPi();
        createExtension(api);

        // Constructing the extension must not open a socket or emit anything.
        await delay(100);
        assert.equal(receiver.received.length, 0);

        await emit("session_start", { type: "session_start" }, makeCtx());
        await waitFor(() => receiver.received.length === 1, {
          label: "events-only session_start",
        });
        assert.equal(receiver.hasCommandClient(), false);

        await emit("session_shutdown", { type: "session_shutdown" }, makeCtx());
        await waitFor(
          () => eventsFor(receiver.received, "session_shutdown").length === 1,
          { label: "events-only session_shutdown" }
        );
        const afterShutdown = receiver.received.length;
        await delay(300);
        assert.equal(receiver.received.length, afterShutdown);
      }
    );
  } finally {
    await receiver.close();
  }
});
