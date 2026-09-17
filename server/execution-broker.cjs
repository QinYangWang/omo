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
      onHeadlessClaim,
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
    // Ownership-transition hook (design §4/§7). `ensure()` fires it once when
    // a detached Session gains its headless runtime, so an explicit idle
    // resume is observable on the public SSE stream instead of happening
    // silently. Later opens reuse the runtime and never reach the hook.
    this.onHeadlessClaim =
      typeof onHeadlessClaim === "function" ? onHeadlessClaim : noop;
    // Daemon-owned command sequencing (design §5). The counter is scoped to
    // one live attachment `(instanceId, generation)` so a duplicate-safe
    // retry reuses the same scope, while a fresh generation starts again at
    // 1. `commandSequenceKeys` lets a detach drop the old scope without
    // scanning every counter.
    this.commandSequences = new Map();
    this.commandSequenceKeys = new Map();
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

  /**
   * Drops the per-attachment command counter once its lease ends. Extension
   * detach and heartbeat expiry both call this, so a re-attach of the same
   * instance can never inherit (or reuse) the previous generation's
   * sequence numbers. Idempotent for unknown sessions.
   */
  onDetach(sessionId) {
    this.clearCommandSequence(sessionId);
  }

  /**
   * Notifies the wired hook that `ensure()` claimed `sessionId` for a
   * headless runtime. `PiService.ensure` only calls this on the creation
   * path: a Session that already owns a runtime returns before reaching it,
   * so exactly one `headless-owned` transition is emitted per idle resume.
   */
  headlessClaimed(sessionId) {
    this.onHeadlessClaim(sessionId);
  }

  /** Forgets the `(instanceId, generation)` command scope for `sessionId`. */
  clearCommandSequence(sessionId) {
    const key = this.commandSequenceKeys.get(sessionId);
    if (key === undefined) {
      return;
    }
    this.commandSequenceKeys.delete(sessionId);
    this.commandSequences.delete(key);
  }

  /**
   * Delivers one Web/Desktop Prompt or Abort command to the current native
   * owner and returns `{ delivered, requestId, commandSequence }`.
   *
   * The ownership read and the send happen in one synchronous block (no
   * `await` in between), mirroring the attach race discipline: the counter
   * and the command are derived from the same live attachment, and
   * `ExtensionService.sendCommand` re-fetches that attachment immediately
   * before writing to its subscriber. On any doubt (no attachment, no live
   * subscriber) the result is `delivered: false`; this method never creates
   * a headless runtime.
   */
  dispatchNativeCommand(sessionId, commandBase) {
    const requestId = commandBase?.requestId;
    const state = this.extensionService.executionState(sessionId);
    if (state.state !== "native-attached") {
      this.clearCommandSequence(sessionId);
      return { commandSequence: undefined, delivered: false, requestId };
    }
    const key = `${state.ownerInstanceId}\u0000${state.generation}`;
    const previousKey = this.commandSequenceKeys.get(sessionId);
    if (previousKey !== undefined && previousKey !== key) {
      // Defensive: a re-attach without an observed detach still resets the
      // counter for the new generation instead of leaking the old one.
      this.commandSequences.delete(previousKey);
    }
    const commandSequence = (this.commandSequences.get(key) ?? 0) + 1;
    this.commandSequences.set(key, commandSequence);
    this.commandSequenceKeys.set(sessionId, key);
    const command =
      commandBase?.type === "prompt"
        ? {
            commandSequence,
            requestId,
            text: commandBase.text,
            type: "prompt",
          }
        : { commandSequence, requestId, type: "abort" };
    const delivered = this.extensionService.sendCommand(sessionId, command);
    return { commandSequence, delivered, requestId };
  }

  dispose() {
    this.extensionService = null;
    this.hasHeadlessRuntime = () => false;
    this.isHeadlessStreaming = () => false;
    this.onHeadlessClaim = noop;
    this.releaseIdleRuntime = noop;
    this.commandSequences.clear();
    this.commandSequenceKeys.clear();
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

/**
 * Appends the single client-visible `native_turn_interrupted` marker when the
 * Session's durable tail still holds an unfinished turn (a `turn_start` with
 * no later `turn_end`). The host calls this once per released attachment, so
 * a lost Extension mid-turn cannot silently look like a completed turn; the
 * outcome stays unknown and no `turn_end`/`message_end`/`agent_end` is ever
 * fabricated (design §4 rule 4 and §6.3). A clean detach after a completed
 * turn (or with no turn at all) appends nothing.
 */
function appendInterruptedTurnEvent(events, sessionId) {
  if (
    !events ||
    typeof events.append !== "function" ||
    typeof events.hasUnfinishedTurn !== "function" ||
    !events.hasUnfinishedTurn(sessionId)
  ) {
    return;
  }
  return events.append(sessionId, {
    code: "native_turn_interrupted",
    message:
      "The native Pi turn was interrupted when its Extension detached; the outcome is unknown and it was not retried.",
    retryable: true,
    type: "omo_error",
  });
}

module.exports = {
  appendExecutionStateEvent,
  appendInterruptedTurnEvent,
  ExecutionBroker,
};
