"use strict";

// Session execution ownership broker (docs/extension-daemon-hybrid.md §4).
//
// A Host Session has exactly one stable execution owner at any moment:
//
//   native-attached  one authenticated Extension attachment executes it;
//   headless-owned   one in-process AgentSession executes it;
//   detached         no live executor (history is still readable).
//
// The broker combines two independent sources of truth: the native attachment
// registry owned by ExtensionService and the live headless runtimes owned by
// PiService. It never stores credentials, generations or Session data of its
// own; `executionState` is a pure projection of those two sources.
//
// Fail closed: a headless runtime that is still being created is reported as
// both live and streaming, so an attach is rejected instead of racing a
// second executor into existence.
//
// Idle handoff invariant (design §4 rule 3): `canAttach` only observes state;
// `onAttachConfirm` performs the idle release. ExtensionService calls both
// inside one synchronous block (no `await` between the gate and the release)
// before the attachment becomes the session's current owner, so a concurrent
// Prompt dispatch can never observe "native attached" and "headless live" at
// the same time.

const noop = () => undefined;

class ExecutionBroker {
  constructor(options = {}) {
    const {
      extensionService,
      hasHeadlessRuntime,
      isHeadlessStreaming,
      releaseIdleRuntime,
    } = options;
    if (
      !extensionService ||
      typeof extensionService.executionState !== "function"
    ) {
      throw new Error("ExecutionBroker requires an ExtensionService");
    }
    this.extensionService = extensionService;
    this.hasHeadlessRuntime =
      typeof hasHeadlessRuntime === "function"
        ? hasHeadlessRuntime
        : () => false;
    this.isHeadlessStreaming =
      typeof isHeadlessStreaming === "function"
        ? isHeadlessStreaming
        : () => false;
    this.releaseIdleRuntime =
      typeof releaseIdleRuntime === "function" ? releaseIdleRuntime : noop;
  }

  /** True only while a live, authenticated Extension owns the Session. */
  nativeAttached(sessionId) {
    return (
      this.extensionService.executionState(sessionId).state ===
      "native-attached"
    );
  }

  /**
   * Public, credential-free ownership view. Always one of the closed union
   * `native-attached` | `headless-owned` | `detached`.
   */
  executionState(sessionId) {
    const native = this.extensionService.executionState(sessionId);
    if (native.state === "native-attached") {
      return native;
    }
    if (this.hasHeadlessRuntime(sessionId)) {
      return { state: "headless-owned" };
    }
    return { state: "detached" };
  }

  /**
   * Gate a native attach. A busy headless runtime is never preempted (design
   * §4 rule 2); "busy" includes a runtime that is still being created and an
   * accepted Prompt that has not dispatched yet, so the gate fails closed even
   * while `isStreaming` is still false. An idle runtime is left for
   * `onAttachConfirm` to release.
   */
  canAttach(sessionId) {
    if (this.isHeadlessStreaming(sessionId)) {
      return { ok: false, reason: "headless_streaming" };
    }
    return { ok: true };
  }

  /**
   * Synchronous idle handoff seam. Called by ExtensionService immediately
   * before the attachment is confirmed; releasing here keeps "release" and
   * "confirm" in the same tick.
   */
  onAttachConfirm(sessionId) {
    this.releaseIdleRuntime(sessionId);
  }

  dispose() {
    this.extensionService = null;
    this.hasHeadlessRuntime = () => false;
    this.isHeadlessStreaming = () => false;
    this.releaseIdleRuntime = noop;
  }
}

/**
 * Projects `sessionId`'s current ownership as one `omo_execution_state` Host
 * event. `ExtensionService` calls this from its attach/detach hooks so SSE
 * consumers observe ownership transitions in real time; headless creation is
 * client-initiated and emits nothing. The payload is credential-free by
 * construction because the broker only ever returns SessionExecutionState
 * shaped data.
 */
function appendExecutionStateEvent(events, broker, sessionId) {
  if (!events || typeof events.append !== "function") {
    return;
  }
  const state = broker?.executionState(sessionId);
  if (!state) {
    return;
  }
  return events.append(sessionId, { type: "omo_execution_state", ...state });
}

module.exports = { appendExecutionStateEvent, ExecutionBroker };
