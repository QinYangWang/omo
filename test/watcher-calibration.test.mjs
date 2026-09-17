// E4-004: the external-Pi JSONL calibration path must survive next to the
// native Extension event stream without ever double-rendering a Turn.
//
// Two ownership regimes share one Session JSONL:
//
//   no Extension  the `fs.watch` debounce (250ms, size-deduplicated) turns a
//                 real external write into exactly one `omo_session_file`
//                 hint; the client follows up with `/pi/sync` to re-read
//                 history from disk (this is the pre-E4 / M1-005 behavior);
//   native owner  a live Extension streams Pi events over the private channel
//                 and the watcher must suppress every `omo_session_file`
//                 hint, because the JSONL is only a persistence record while
//                 the native process owns the Session (design §8).
//
// Client `omo_session_file` semantics (scenario 6). This revision has no
// `src/lib/omo-session-events.ts`; the Web client consumes the hint in
// `src/components/ChatView.tsx`:
//
//   ensureApiEventBridge  ->  `event.type === "omo_session_file"` fans out to
//                             `subscribeFileSync` listeners and returns before
//                             `handlePiEvent`, so calibration hints never enter
//                             the native delta reducer;
//   subscribeFileSync     ->  debounce 300ms;
//   syncFromFile          ->  `api.pi.sync(sessionId, sessionPath, turnCount,
//                             tailItemCount)` (`src/lib/remote-api.ts`);
//   mergeSyncResult       ->  by absolute Turn index:
//                             `turns = [...current.turns.slice(0, cut),
//                                       ...toTurns(result.messages, result.fromTurn)]`
//                             and `fromTurn === -1` only refreshes the outline
//                             metas.
//
// The merge is a REPLACE from an absolute Turn onward, never a blind append,
// so replaying the same hint any number of times is idempotent. Combined with
// the server suppression below this makes double render impossible: while the
// native stream is the source there are zero calibration events; when there is
// no native owner there are only replace-only calibration events and no
// native stream.
//
// Documented deviations from the task brief (asserted against the shipped
// contract, not "fixed"): `watchSessionFile` does not reload history itself and
// does not attach `messageCount` / `lastType` / `lastMessageRole` metadata. It
// appends `{ path, type: "omo_session_file" }`; the metadata snapshot is
// rebuilt by the client's `/pi/sync` round-trip. There is no `appendOmo` helper
// and no `hasPendingExternalSession` flag, and `docs/extension-daemon-hybrid.md`
// has no §5.3 in this revision.
//
// The watcher trigger is injected (a fake `fs.watch` that records the listener)
// so the debounce boundary can be controlled without racing real fs latency;
// file sizes still change for real, because the debounce dedupes on `statSync`
// size.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { EventStore } = require("../server/event-store.cjs");
const { ExecutionBroker } = require("../server/execution-broker.cjs");
const { ExtensionService } = require("../server/extension-service.cjs");
const { createNativeEventHandler } = require("../server/native-events.cjs");
const { PiService } = require("../server/pi-service.cjs");

const SESSION_ID = "session-watcher-calibration";
// `server/pi-service.cjs` hard-codes a 250ms debounce.
const WATCHER_DEBOUNCE_MS = 250;
// Comfortably past the debounce, but still bounded.
const SETTLE_MS = WATCHER_DEBOUNCE_MS + 250;
// Less than the debounce: the timer is scheduled but cannot have fired yet.
const PENDING_MS = 70;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Replaces `fs.watch` with a registry that captures each listener so a test
 * can fire a file-change notification at an exact moment. `statSync` and the
 * actual file writes stay real, so the size dedupe in `watchSessionFile` is
 * exercised unmodified. `restore()` must run before the next test.
 */
function createFakeWatchRegistry() {
  const listeners = new Map();
  const originalWatch = fs.watch;
  const registry = {
    listeners,
    restore() {
      fs.watch = originalWatch;
    },
    trigger(filePath) {
      const entry = listeners.get(filePath);
      assert.ok(entry, `expected a registered watcher for ${filePath}`);
      entry.listener();
    },
  };
  fs.watch = (filePath, _options, listener) => {
    const watcher = {
      close() {
        listeners.delete(filePath);
      },
      listener,
      on() {
        return watcher;
      },
    };
    listeners.set(filePath, watcher);
    return watcher;
  };
  return registry;
}

/** In-process PiService with a controllable fake native attachment. */
function createHarness(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-watcher-calib-"));
  const events = new EventStore(dataDir);
  const workspace = { resolveExisting: async (value) => value };
  const state = {
    branch: options.branch ?? [],
    historyLoads: 0,
  };
  const manager = {
    getBranch: () => state.branch,
    getSessionId: () => SESSION_ID,
  };
  const adapter = {
    openSessionDocument: () => {
      state.historyLoads += 1;
      return manager;
    },
  };
  const service = new PiService(events, workspace, workspace, adapter);
  let nativeAttached = false;
  const broker = {
    executionState: () =>
      nativeAttached
        ? {
            generation: 1,
            ownerInstanceId: "fake-native-instance",
            state: "native-attached",
          }
        : { state: "detached" },
    nativeAttached: () => nativeAttached,
  };
  service.setExecutionBroker(broker);
  const nativeHandler = createNativeEventHandler({ events });
  const filePath = path.join(dataDir, options.fileName ?? "session.jsonl");
  fs.writeFileSync(filePath, options.initialContent ?? "line-0\n");
  const watch = createFakeWatchRegistry();

  return {
    append(text) {
      fs.appendFileSync(filePath, text);
    },
    close() {
      watch.restore();
      service.dispose();
      events.close();
      fs.rmSync(dataDir, { force: true, recursive: true });
    },
    dataDir,
    events,
    filePath,
    nativeHandler,
    service,
    setNativeAttached(value) {
      nativeAttached = value;
    },
    state,
    watch,
  };
}

/** Real ExtensionService + broker + PiService, as wired by the Host. */
function createExtensionHarness() {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "omo-watcher-native-calib-")
  );
  const events = new EventStore(dataDir);
  const workspace = { resolveExisting: async (value) => value };
  const adapter = {
    openSessionDocument: () => ({
      getBranch: () => [],
      getSessionId: () => SESSION_ID,
    }),
  };
  const service = new PiService(events, workspace, workspace, adapter);
  const nativeHandler = createNativeEventHandler({ events });
  let broker;
  const extensionService = new ExtensionService({
    canAttach: (id) => broker.canAttach(id),
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 60_000,
    hostId: crypto.randomUUID(),
    onAttachConfirm: (id) => broker.onAttachConfirm(id),
    onNativeEvent: (attachment, event) =>
      nativeHandler.handle(attachment, event),
    sweepIntervalMs: 60_000,
  });
  broker = new ExecutionBroker({
    extensionService,
    hasHeadlessRuntime: (id) => service.hasRuntime(id),
    isHeadlessStreaming: (id) => service.isRuntimeStreaming(id),
    releaseIdleRuntime: (id) => service.releaseIdleRuntime(id),
  });
  service.setExecutionBroker(broker);
  const filePath = path.join(dataDir, "session.jsonl");
  fs.writeFileSync(filePath, "line-0\n");
  const watch = createFakeWatchRegistry();

  return {
    append(text) {
      fs.appendFileSync(filePath, text);
    },
    close() {
      watch.restore();
      extensionService.dispose();
      service.dispose();
      events.close();
      fs.rmSync(dataDir, { force: true, recursive: true });
    },
    events,
    extensionService,
    filePath,
    nativeHandler,
    service,
    watch,
  };
}

function registerRequest(sessionId, overrides = {}) {
  return {
    capabilities: ["commands", "events"],
    channelVersion: 1,
    extensionVersion: "0.1.0-test",
    instanceId: crypto.randomUUID(),
    piVersion: "0.85.0-test",
    sessionId,
    ...overrides,
  };
}

function nativeEvent(sequence, overrides = {}) {
  return {
    event: "message_update",
    nativeSequence: sequence,
    payload: { type: "message_update" },
    sessionId: SESSION_ID,
    timestamp: Date.now(),
    ...overrides,
  };
}

function messageEntry(id, message) {
  return { id, message, type: "message" };
}

/** All `omo_session_file` calibration records for one Session. */
function calibrationEvents(events, sessionId = SESSION_ID) {
  return events
    .list(sessionId)
    .filter((record) => record.type === "omo_session_file");
}

/**
 * Count user/assistant message starts in the combined Host event stream. One
 * Turn streamed natively yields exactly one `message_start` per role; a
 * duplicated calibration event would have to add a second one to fool this.
 */
function countStartedMessages(events, sessionId = SESSION_ID) {
  const counts = { assistant: 0, user: 0 };
  for (const record of events.list(sessionId)) {
    const role = record.payload?.message?.role;
    if (
      record.type === "message_start" &&
      (role === "assistant" || role === "user")
    ) {
      counts[role] += 1;
    }
  }
  return counts;
}

test("no extension: one debounced hint per external change and no reload inside the watcher", async () => {
  const h = createHarness();
  try {
    h.service.watchSessionFile(SESSION_ID, h.filePath);
    assert.equal(h.watch.listeners.size, 1);
    assert.equal(h.state.historyLoads, 0);

    // A single real external write -> exactly one calibration hint.
    h.append("line-1\n");
    h.watch.trigger(h.filePath);
    await delay(SETTLE_MS);

    const first = calibrationEvents(h.events);
    assert.equal(first.length, 1);
    assert.equal(first[0].type, "omo_session_file");
    assert.equal(first[0].payload.path, h.filePath);
    // The shipped watcher is a pure hint: it never reloads history itself.
    assert.equal(h.state.historyLoads, 0);

    // Rapid successive writes (all inside one debounce window) collapse into
    // exactly one additional hint.
    h.append("line-2\n");
    h.watch.trigger(h.filePath);
    await delay(40);
    h.append("line-3\n");
    h.watch.trigger(h.filePath);
    await delay(40);
    h.append("line-4\n");
    h.watch.trigger(h.filePath);
    await delay(SETTLE_MS);
    assert.equal(calibrationEvents(h.events).length, 2);

    // The calibration round-trip the client performs after each hint rebuilds
    // the metadata (messageCount / lastType / lastMessageRole equivalent) from
    // disk, replacing rather than appending.
    h.state.branch = [
      messageEntry("entry-1", {
        content: "hello",
        role: "user",
        timestamp: 1,
      }),
      messageEntry("entry-2", {
        content: [{ text: "hi there", type: "text" }],
        role: "assistant",
        timestamp: 2,
      }),
    ];
    const result = await h.service.sync({
      sessionId: SESSION_ID,
      sessionPath: h.filePath,
      tailItemCount: 0,
      turnCount: 0,
    });
    assert.equal(h.state.historyLoads, 1);
    assert.equal(result.fromTurn, 0);
    assert.equal(result.totalTurns, 1);
    assert.ok(result.messages.length >= 2);
  } finally {
    await h.close();
  }
});

test("native-attached: external changes emit nothing, reload nothing, and the native stream stays exactly-once", async () => {
  const h = createHarness();
  try {
    h.service.watchSessionFile(SESSION_ID, h.filePath);
    h.setNativeAttached(true);

    // One complete Turn arrives over the native channel while attached.
    h.nativeHandler.handle(
      { sessionId: SESSION_ID },
      nativeEvent(1, { event: "turn_start", payload: { turnIndex: 0 } })
    );
    h.nativeHandler.handle(
      { sessionId: SESSION_ID },
      nativeEvent(2, {
        event: "message_start",
        payload: { message: { role: "user" } },
      })
    );
    h.nativeHandler.handle(
      { sessionId: SESSION_ID },
      nativeEvent(3, {
        event: "message_start",
        payload: { message: { role: "assistant" } },
      })
    );
    h.nativeHandler.handle(
      { sessionId: SESSION_ID },
      nativeEvent(4, {
        event: "message_update",
        payload: {
          assistantMessageEvent: { delta: "hi", type: "text_delta" },
        },
      })
    );
    h.nativeHandler.handle(
      { sessionId: SESSION_ID },
      nativeEvent(5, {
        event: "message_end",
        payload: { message: { role: "assistant" } },
      })
    );

    // The external Pi process flushes the same Turn to the JSONL while the
    // native attachment owns the Session.
    h.append("line-external\n");
    h.watch.trigger(h.filePath);
    await delay(SETTLE_MS);

    assert.equal(calibrationEvents(h.events).length, 0);
    // No hint -> no client calibration -> no history load on the server.
    assert.equal(h.state.historyLoads, 0);
    // Combined-stream message count is native-only: exactly one user and one
    // assistant start, i.e. the Turn is derivable exactly once.
    assert.deepEqual(countStartedMessages(h.events), {
      assistant: 1,
      user: 1,
    });
    assert.deepEqual(
      h.events.list(SESSION_ID).map((record) => record.type),
      [
        "turn_start",
        "message_start",
        "message_start",
        "message_update",
        "message_end",
      ]
    );
  } finally {
    await h.close();
  }
});

test("attach boundary: suppression reads ownership at fire time, not at schedule time", async () => {
  const h = createHarness();
  try {
    h.service.watchSessionFile(SESSION_ID, h.filePath);

    // (a) Scheduled while detached, attach lands before the debounce fires.
    // Schedule-time evaluation would still emit here.
    h.append("race-attach\n");
    h.watch.trigger(h.filePath);
    await delay(PENDING_MS);
    assert.equal(calibrationEvents(h.events).length, 0);
    h.setNativeAttached(true);
    await delay(SETTLE_MS);
    assert.equal(calibrationEvents(h.events).length, 0);

    // (b) Scheduled while attached, detach lands before the debounce fires.
    // A snapshot of the schedule-time state would wrongly suppress here.
    h.append("race-detach\n");
    h.watch.trigger(h.filePath);
    await delay(PENDING_MS);
    h.setNativeAttached(false);
    await delay(SETTLE_MS);
    assert.equal(calibrationEvents(h.events).length, 1);
  } finally {
    await h.close();
  }
});

test("detach restores calibration after a suppressed write", async () => {
  const h = createHarness();
  try {
    h.service.watchSessionFile(SESSION_ID, h.filePath);

    h.setNativeAttached(true);
    h.append("attached-write\n");
    h.watch.trigger(h.filePath);
    await delay(SETTLE_MS);
    assert.equal(calibrationEvents(h.events).length, 0);

    h.setNativeAttached(false);
    h.append("detached-write\n");
    h.watch.trigger(h.filePath);
    await delay(SETTLE_MS);
    assert.equal(calibrationEvents(h.events).length, 1);
  } finally {
    await h.close();
  }
});

test("no prior history: the pending-external-session hint follows the same suppression rules", async () => {
  // An empty file is the "brand-new session" shape: `loadHistory` is empty and
  // `sync` returns `fromTurn: -1`. This revision has no separate
  // `hasPendingExternalSession` flag; the only hint is `omo_session_file`, and
  // it is suppressed uniformly while a native owner exists (a suppressed
  // pending-history hint is harmless because the native stream is the source).
  const h = createHarness({ initialContent: "" });
  try {
    h.service.watchSessionFile(SESSION_ID, h.filePath);

    // Detached: the hint is emitted even though disk history is empty.
    h.append("external-1\n");
    h.watch.trigger(h.filePath);
    await delay(SETTLE_MS);
    assert.equal(calibrationEvents(h.events).length, 1);

    const empty = await h.service.sync({
      sessionId: SESSION_ID,
      sessionPath: h.filePath,
      tailItemCount: 0,
      turnCount: 0,
    });
    assert.equal(empty.fromTurn, -1);
    assert.deepEqual(empty.messages, []);
    assert.equal(empty.totalTurns, 0);

    // Native-attached: the pending-external-session hint is suppressed.
    h.setNativeAttached(true);
    h.append("external-2\n");
    h.watch.trigger(h.filePath);
    await delay(SETTLE_MS);
    assert.equal(calibrationEvents(h.events).length, 1);

    // Detached again: the hint resumes for the next real change.
    h.setNativeAttached(false);
    h.append("external-3\n");
    h.watch.trigger(h.filePath);
    await delay(SETTLE_MS);
    assert.equal(calibrationEvents(h.events).length, 2);
  } finally {
    await h.close();
  }
});

test("real Extension registration suppresses calibration and detach restores it", async () => {
  const h = createExtensionHarness();
  try {
    const request = registerRequest(SESSION_ID);
    const registered = await h.extensionService.register(request);
    assert.equal(registered.ok, true);
    assert.equal(h.service.nativeAttached(SESSION_ID), true);

    h.service.watchSessionFile(SESSION_ID, h.filePath);
    h.append("native-owned-write\n");
    h.watch.trigger(h.filePath);
    await delay(SETTLE_MS);
    assert.equal(calibrationEvents(h.events).length, 0);

    // Native events still flow through the real Extension channel.
    const posted = await h.extensionService.events(
      {
        events: [
          nativeEvent(1, {
            event: "message_start",
            payload: { message: { role: "user" } },
          }),
        ],
        generation: registered.generation,
        instanceId: request.instanceId,
      },
      registered.credential
    );
    assert.deepEqual(posted, { accepted: 1, duplicates: 0, ok: true });
    assert.deepEqual(countStartedMessages(h.events), {
      assistant: 0,
      user: 1,
    });

    await h.extensionService.detach(
      {
        generation: registered.generation,
        instanceId: request.instanceId,
        reason: "detached",
      },
      registered.credential
    );
    assert.equal(h.service.nativeAttached(SESSION_ID), false);

    h.append("after-detach-write\n");
    h.watch.trigger(h.filePath);
    await delay(SETTLE_MS);
    assert.equal(calibrationEvents(h.events).length, 1);
  } finally {
    await h.close();
  }
});
