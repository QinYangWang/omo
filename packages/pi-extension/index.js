import { randomUUID } from "node:crypto";

const EVENTS_URL_ENV = "OMO_EXTENSION_EVENTS_URL";
const REQUEST_TIMEOUT_MS = 1500;
const MAX_ERROR_LOGS = 3;
const MAX_PENDING = 128;
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Native Pi events forwarded to the omo test receiver. Keeping this list
 * explicit makes the spike contract auditable against Pi 0.85.0.
 */
const STREAM_EVENTS = [
  "agent_start",
  "agent_end",
  "message_end",
  "message_start",
  "message_update",
  "tool_execution_end",
  "tool_execution_start",
  "tool_execution_update",
  "turn_end",
  "turn_start",
];

/**
 * Convert an arbitrary Pi event payload into a JSON-safe value. Handles
 * BigInt, functions, Errors, Dates, `undefined` and circular references so a
 * single forwarding failure can never break the Pi event pipeline.
 */
const sanitize = (value, seen) => {
  if (value === null) {
    return null;
  }
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") {
    return value;
  }
  if (type === "bigint") {
    return value.toString();
  }
  if (type !== "object") {
    return;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => sanitize(item, seen));
  } else if (value instanceof Error) {
    result = { message: value.message, name: value.name };
  } else if (value instanceof Date) {
    result = value.toISOString();
  } else {
    result = {};
    for (const [key, item] of Object.entries(value)) {
      const safe = sanitize(item, seen);
      if (safe !== undefined) {
        result[key] = safe;
      }
    }
  }
  seen.delete(value);
  return result;
};

const toJsonSafe = (value) => sanitize(value, new WeakSet());

export default function omoEventForwarder(pi) {
  const eventsUrl = process.env[EVENTS_URL_ENV]?.trim();
  if (!eventsUrl) {
    // No receiver configured: stay completely inert (no network, no timers).
    return;
  }

  const instanceId = randomUUID();
  let nativeSequence = 0;
  let sessionId;
  let sessionFile;
  let active = false;
  let errorLogs = 0;
  let consecutiveFailures = 0;
  let degraded = false;
  let draining = false;
  let pending = [];

  const logForwardingError = (error) => {
    if (errorLogs >= MAX_ERROR_LOGS) {
      return;
    }
    errorLogs += 1;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[omo-pi-extension] event delivery failed: ${message}\n`
    );
  };

  const postOnce = async (body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      await fetch(eventsUrl, {
        body,
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  // Fire-and-forget with at most one retry. Never rejects, so a dead receiver
  // can never surface an unhandled rejection inside Pi.
  const deliver = async (body) => {
    try {
      await postOnce(body);
      return true;
    } catch {
      try {
        await postOnce(body);
        return true;
      } catch (error) {
        logForwardingError(error);
        return false;
      }
    }
  };

  // Drain one event at a time so nativeSequence ordering is preserved at the
  // receiver without ever awaiting delivery inside the agent loop. A dead
  // receiver trips a circuit breaker that drops the backlog instead of
  // delaying process shutdown indefinitely.
  const drain = async () => {
    const body = pending.shift();
    if (body === undefined || degraded) {
      draining = false;
      if (degraded) {
        pending = [];
      }
      return;
    }
    const delivered = await deliver(body);
    consecutiveFailures = delivered ? 0 : consecutiveFailures + 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      degraded = true;
    }
    await drain();
  };

  const forward = (eventName, payload, ctx) => {
    if (!active || degraded) {
      return;
    }
    nativeSequence += 1;
    if (ctx?.sessionManager) {
      sessionId = ctx.sessionManager.getSessionId();
      sessionFile = ctx.sessionManager.getSessionFile();
    }
    pending.push(
      JSON.stringify({
        event: eventName,
        instanceId,
        nativeSequence,
        payload: toJsonSafe(payload),
        sessionFile,
        sessionId,
        timestamp: Date.now(),
      })
    );
    if (pending.length > MAX_PENDING) {
      pending.shift();
    }
    if (!draining) {
      draining = true;
      drain();
    }
  };

  pi.on("session_start", (event, ctx) => {
    active = true;
    // A fresh session may see a recovered receiver; reset the breaker without
    // touching the process-scoped sequence, instance id or in-flight drain.
    consecutiveFailures = 0;
    degraded = false;
    forward("session_start", event, ctx);
  });

  pi.on("session_shutdown", (event, ctx) => {
    forward("session_shutdown", event, ctx);
    active = false;
  });

  for (const eventName of STREAM_EVENTS) {
    pi.on(eventName, (event, ctx) => {
      forward(eventName, event, ctx);
    });
  }
}
