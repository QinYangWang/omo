import { randomUUID } from "node:crypto";

const EVENTS_URL_ENV = "OMO_EXTENSION_EVENTS_URL";
const COMMANDS_URL_ENV = "OMO_EXTENSION_COMMANDS_URL";
const REQUEST_TIMEOUT_MS = 1500;
const MAX_ERROR_LOGS = 3;
const MAX_PENDING = 128;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_SEEN_REQUEST_IDS = 1024;
const COMMAND_RECONNECT_ATTEMPTS = 3;
const COMMAND_RECONNECT_BASE_MS = 500;

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

const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error);

export default function omoEventForwarder(pi) {
  const eventsUrl = process.env[EVENTS_URL_ENV]?.trim();
  if (!eventsUrl) {
    // No receiver configured: stay completely inert (no network, no timers).
    return;
  }
  // The command channel is only meaningful when acks have somewhere to go.
  // Without OMO_EXTENSION_COMMANDS_URL the E0-002 forwarding behavior is
  // unchanged.
  const commandsUrl = process.env[COMMANDS_URL_ENV]?.trim();

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
    process.stderr.write(
      `[omo-pi-extension] event delivery failed: ${errorMessage(error)}\n`
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

  // Drain one record at a time so nativeSequence ordering is preserved at the
  // receiver without ever awaiting delivery inside the agent loop. A dead
  // receiver trips a circuit breaker that drops the backlog instead of
  // delaying process shutdown indefinitely. Ack senders can await the returned
  // promise to learn whether their record was actually delivered.
  const enqueue = (record) =>
    new Promise((resolve) => {
      pending.push({
        body: JSON.stringify(record),
        resolve,
      });
      if (pending.length > MAX_PENDING) {
        const dropped = pending.shift();
        dropped?.resolve(false);
      }
      if (!draining) {
        draining = true;
        drain();
      }
    });

  const drain = async () => {
    const item = pending.shift();
    if (item === undefined) {
      draining = false;
      return;
    }
    if (degraded) {
      item.resolve(false);
      for (const dropped of pending) {
        dropped.resolve(false);
      }
      pending = [];
      draining = false;
      return;
    }
    const delivered = await deliver(item.body);
    consecutiveFailures = delivered ? 0 : consecutiveFailures + 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      degraded = true;
    }
    item.resolve(delivered);
    await drain();
  };

  const nextSequence = () => {
    nativeSequence += 1;
    return nativeSequence;
  };

  const forward = (eventName, payload, ctx) => {
    if (!active || degraded) {
      return;
    }
    if (ctx?.sessionManager) {
      sessionId = ctx.sessionManager.getSessionId();
      sessionFile = ctx.sessionManager.getSessionFile();
    }
    // Intentionally not awaited: a slow receiver must never stall Pi.
    enqueue({
      event: eventName,
      instanceId,
      nativeSequence: nextSequence(),
      payload: toJsonSafe(payload),
      sessionFile,
      sessionId,
      timestamp: Date.now(),
    });
  };

  // ---------------------------------------------------------------------------
  // Command channel (E0-003)
  //
  // The extension only ever connects OUT to the harness-owned command stream.
  // It never opens a listening socket. A command is applied at most once per
  // process instance: stale commandSequence values are dropped and duplicate
  // requestIds are rejected without executing anything.
  // ---------------------------------------------------------------------------

  let sessionCtx;
  let commandStopped = false;
  let commandAttempts = 0;
  let commandController;
  let commandReconnectTimer;
  const seenRequestIds = new Set();
  const requestIdOrder = [];
  let lastCommandSequence = 0;
  let activePrompt;
  let promptStarted = false;
  let activeAbort;
  let lastAssistantStopReason;

  const sendAck = (fields) =>
    enqueue({
      ...fields,
      instanceId,
      kind: "ack",
      nativeSequence: nextSequence(),
      sessionFile,
      sessionId,
      timestamp: Date.now(),
    });

  const rememberRequestId = (requestId) => {
    seenRequestIds.add(requestId);
    requestIdOrder.push(requestId);
    if (requestIdOrder.length > MAX_SEEN_REQUEST_IDS) {
      const oldest = requestIdOrder.shift();
      seenRequestIds.delete(oldest);
    }
  };

  const rejectCommand = (requestId, commandSequence, reason) =>
    sendAck({ commandSequence, reason, requestId, status: "rejected" });

  const isCtxIdle = (ctx, whenUnknown) => {
    try {
      return ctx.isIdle();
    } catch {
      return whenUnknown;
    }
  };

  const handlePromptCommand = async ({ requestId, commandSequence, text }) => {
    if (typeof text !== "string" || text.trim().length === 0) {
      await rejectCommand(requestId, commandSequence, "empty_text");
      return;
    }
    const ctx = sessionCtx;
    if (!(active && ctx)) {
      await rejectCommand(requestId, commandSequence, "no_active_session");
      return;
    }
    if (!isCtxIdle(ctx, false)) {
      await rejectCommand(requestId, commandSequence, "turn_already_running");
      return;
    }
    await sendAck({ commandSequence, requestId, status: "accepted" });
    activePrompt = { commandSequence, requestId };
    promptStarted = false;
    try {
      // Native Pi capability. `sendUserMessage` is fire-and-forget from the
      // extension API; a `started` ack is only emitted once Pi actually begins
      // the run (agent_start), never optimistically here.
      pi.sendUserMessage(text);
    } catch (error) {
      activePrompt = undefined;
      await rejectCommand(
        requestId,
        commandSequence,
        `dispatch_failed: ${errorMessage(error)}`
      );
    }
  };

  const handleAbortCommand = async ({ requestId, commandSequence }) => {
    const ctx = sessionCtx;
    if (!(active && ctx)) {
      await rejectCommand(requestId, commandSequence, "no_active_session");
      return;
    }
    if (isCtxIdle(ctx, true)) {
      await rejectCommand(requestId, commandSequence, "no_active_turn");
      return;
    }
    activeAbort = { commandSequence, requestId };
    try {
      ctx.abort();
    } catch (error) {
      activeAbort = undefined;
      await rejectCommand(
        requestId,
        commandSequence,
        `abort_failed: ${errorMessage(error)}`
      );
      return;
    }
    await sendAck({ commandSequence, requestId, status: "accepted" });
  };

  const parseCommand = (raw) => {
    let command;
    try {
      command = JSON.parse(raw);
    } catch {
      // A malformed command must never crash the Pi session.
      return;
    }
    if (
      command === null ||
      typeof command !== "object" ||
      Array.isArray(command)
    ) {
      return;
    }
    return command;
  };

  const handleCommand = async (raw) => {
    const command = parseCommand(raw);
    if (!command) {
      return;
    }
    const { requestId, commandSequence } = command;
    if (typeof requestId !== "string" || requestId.length === 0) {
      // Without a requestId there is nothing to correlate an ack with.
      return;
    }
    if (
      typeof commandSequence !== "number" ||
      !Number.isFinite(commandSequence)
    ) {
      await rejectCommand(requestId, null, "invalid_command_sequence");
      return;
    }
    if (commandSequence <= lastCommandSequence) {
      // Out-of-order or already-applied command: ignore silently.
      return;
    }
    lastCommandSequence = commandSequence;
    if (seenRequestIds.has(requestId)) {
      await rejectCommand(requestId, commandSequence, "duplicate_request");
      return;
    }
    rememberRequestId(requestId);
    if (command.type === "prompt") {
      await handlePromptCommand(command);
      return;
    }
    if (command.type === "abort") {
      await handleAbortCommand(command);
      return;
    }
    await rejectCommand(
      requestId,
      commandSequence,
      `unknown_command_type: ${String(command.type)}`
    );
  };

  // Minimal SSE frame parser. Frames are separated by a blank line; only
  // `data:` payloads are interpreted and comments/keep-alives are ignored.
  // Commands are processed strictly in arrival order through a serial queue so
  // sequence tracking and acks stay deterministic.
  const commandQueue = [];
  let commandDraining = false;

  const processCommands = async () => {
    const data = commandQueue.shift();
    if (data === undefined) {
      commandDraining = false;
      return;
    }
    try {
      await handleCommand(data);
    } catch (error) {
      // Handler errors are swallowed so one bad command can never kill the
      // stream or the Pi session.
      logForwardingError(error);
    }
    await processCommands();
  };

  const enqueueCommand = (data) => {
    commandQueue.push(data);
    if (!commandDraining) {
      commandDraining = true;
      processCommands();
    }
  };

  const extractSseData = (frame) =>
    frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

  const readCommandStream = async (stream) => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const value of stream) {
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = extractSseData(frame);
        if (data.length > 0) {
          enqueueCommand(data);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  };

  const scheduleCommandReconnect = () => {
    if (commandStopped || commandReconnectTimer) {
      return;
    }
    if (commandAttempts >= COMMAND_RECONNECT_ATTEMPTS) {
      return;
    }
    commandAttempts += 1;
    const delayMs = COMMAND_RECONNECT_BASE_MS * 2 ** (commandAttempts - 1);
    commandReconnectTimer = setTimeout(() => {
      commandReconnectTimer = undefined;
      openCommandStream();
    }, delayMs);
    commandReconnectTimer.unref?.();
  };

  const openCommandStream = () => {
    if (commandStopped || !commandsUrl || commandController) {
      return;
    }
    const controller = new AbortController();
    commandController = controller;
    const run = async () => {
      try {
        const response = await fetch(commandsUrl, {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!(response.ok && response.body)) {
          throw new Error(
            `command stream rejected with HTTP ${response.status}`
          );
        }
        commandAttempts = 0;
        await readCommandStream(response.body);
      } catch (error) {
        if (controller.signal.aborted || commandStopped) {
          return;
        }
        logForwardingError(error);
      } finally {
        if (commandController === controller) {
          commandController = undefined;
        }
      }
      scheduleCommandReconnect();
    };
    run();
  };

  const closeCommandStream = () => {
    commandStopped = true;
    if (commandReconnectTimer) {
      clearTimeout(commandReconnectTimer);
      commandReconnectTimer = undefined;
    }
    const controller = commandController;
    commandController = undefined;
    controller?.abort();
  };

  const finishTurn = async () => {
    const prompt = activePrompt;
    const abort = activeAbort;
    activePrompt = undefined;
    activeAbort = undefined;
    promptStarted = false;
    const reason = lastAssistantStopReason;
    lastAssistantStopReason = undefined;
    if (prompt) {
      await sendAck({
        commandSequence: prompt.commandSequence,
        reason,
        requestId: prompt.requestId,
        status: "completed",
      });
    }
    if (abort) {
      await sendAck({
        commandSequence: abort.commandSequence,
        reason,
        requestId: abort.requestId,
        status: "completed",
      });
    }
  };

  pi.on("session_start", (event, ctx) => {
    active = true;
    // A fresh session may see a recovered receiver; reset the breaker without
    // touching the process-scoped sequence, instance id or in-flight drain.
    consecutiveFailures = 0;
    degraded = false;
    sessionCtx = ctx;
    activePrompt = undefined;
    promptStarted = false;
    activeAbort = undefined;
    lastAssistantStopReason = undefined;
    if (commandsUrl) {
      closeCommandStream();
      commandStopped = false;
      commandAttempts = 0;
      openCommandStream();
    }
    forward("session_start", event, ctx);
  });

  pi.on("session_shutdown", (event, ctx) => {
    forward("session_shutdown", event, ctx);
    active = false;
    sessionCtx = undefined;
    closeCommandStream();
  });

  // Only registered when the command channel is configured. These handlers
  // turn native lifecycle events into truthful `started` / `completed` acks.
  if (commandsUrl) {
    pi.on("agent_start", () => {
      if (!activePrompt || promptStarted) {
        return;
      }
      promptStarted = true;
      const { commandSequence, requestId } = activePrompt;
      sendAck({ commandSequence, requestId, status: "started" });
    });

    pi.on("message_end", (event) => {
      if (event?.message?.role === "assistant") {
        lastAssistantStopReason = event.message.stopReason;
      }
    });

    pi.on("agent_settled", () => {
      finishTurn();
    });
  }

  for (const eventName of STREAM_EVENTS) {
    pi.on(eventName, (event, ctx) => {
      forward(eventName, event, ctx);
    });
  }
}
