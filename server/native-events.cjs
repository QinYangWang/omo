"use strict";

// Native Pi event -> Host EventStore mapper (docs/extension-daemon-hybrid.md
// §5 and §6.1).
//
// ExtensionService has already validated the short-lived instance credential
// and the `(instanceId, generation)` lease, and deduplicated
// `(instanceId, generation, nativeSequence)`. Only fresh events reach the
// `onNativeEvent` hook, in native sequence order. This module owns the final
// identity fence and the payload shape the Web client already renders
// (`adaptPiEvent` in src/lib/pi-adapter.ts expects
// `{ type: "<pi event name>", ...eventFields }`).
//
// The mapping is deliberately synchronous and stateless apart from two
// counters: appending in hook-call order keeps the Host `sequence` aligned
// with the native sequence, and no event accepted by the registry is batched,
// deferred or reordered. A malformed event is counted and dropped instead of
// throwing back into ExtensionService. No per-event state is retained beyond
// what the EventStore already keeps.

function createNativeEventHandler({ events } = {}) {
  if (!events || typeof events.append !== "function") {
    throw new Error("createNativeEventHandler requires an EventStore");
  }
  const stats = { dropped: 0, mapped: 0 };
  return {
    /**
     * Appends one fresh native event and returns the stored record, or `null`
     * when the event was fenced out (its session does not match the owning
     * attachment) or malformed. Never throws.
     *
     * The Pi event name always wins over a conflicting `type` carried in the
     * payload, so clients keep seeing the exact event shape they subscribe to.
     */
    handle(attachment, nativeEvent) {
      try {
        const sessionId = nativeEvent?.sessionId;
        const eventName = nativeEvent?.event;
        if (
          !attachment ||
          typeof sessionId !== "string" ||
          sessionId.length === 0 ||
          sessionId !== attachment.sessionId ||
          typeof eventName !== "string" ||
          eventName.length === 0
        ) {
          stats.dropped += 1;
          return null;
        }
        const record = events.append(sessionId, {
          ...nativeEvent.payload,
          type: eventName,
        });
        stats.mapped += 1;
        return record;
      } catch {
        stats.dropped += 1;
        return null;
      }
    },
    stats,
  };
}

module.exports = { createNativeEventHandler };
