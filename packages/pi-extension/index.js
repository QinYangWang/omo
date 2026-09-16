import { randomUUID } from "node:crypto";
import { errorMessage, toJsonSafe } from "./daemon-channel.mjs";

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

const readSessionId = (ctx) => {
  try {
    return ctx?.sessionManager?.getSessionId() ?? undefined;
  } catch {
    // The session manager may already be torn down; treat it as unknown.
  }
};

const readSessionFile = (ctx) => {
  try {
    return ctx?.sessionManager?.getSessionFile() ?? undefined;
  } catch {
    // The session manager may already be torn down; treat it as unknown.
  }
};

/**
 * Serialized, bounded delivery queue. One record is delivered at a time so
 * `nativeSequence` ordering is preserved at the receiver without ever
 * awaiting delivery inside the agent loop. A dead receiver trips the
 * `isDropped` circuit breaker and drops the backlog instead of delaying
 * process shutdown indefinitely.
 */
class SerialDeliveryQueue {
  constructor({ deliver, isDropped, maxPending = MAX_PENDING }) {
    this.deliver = deliver;
    this.isDropped = isDropped;
    this.maxPending = maxPending;
    this.pending = [];
    this.draining = false;
  }

  enqueue(item) {
    return new Promise((resolve) => {
      this.pending.push({ item, resolve });
      if (this.pending.length > this.maxPending) {
        const dropped = this.pending.shift();
        dropped?.resolve(false);
      }
      if (!this.draining) {
        this.draining = true;
        this.#drain();
      }
    });
  }

  dropAll() {
    const { pending } = this;
    this.pending = [];
    for (const entry of pending) {
      entry.resolve(false);
    }
  }

  async #drain() {
    const entry = this.pending.shift();
    if (entry === undefined) {
      this.draining = false;
      return;
    }
    if (this.isDropped?.()) {
      entry.resolve(false);
      this.dropAll();
      this.draining = false;
      return;
    }
    let delivered = false;
    try {
      delivered = await this.deliver(entry.item);
    } catch {
      delivered = false;
    }
    entry.resolve(delivered);
    await this.#drain();
  }
}

/**
 * Per-session spike state. All mutable resources (timers, command stream,
 * delivery queue) are created in `start` and released in `dispose`, so a
 * double `session_shutdown` or a `session_start` cycle leaves nothing behind.
 * The extension factory itself only holds immutable configuration.
 */
function createSpikeSession({
  commandsUrl,
  eventsUrl,
  instanceId,
  log,
  nextSequence,
  pi,
}) {
  let active = false;
  let sessionId;
  let sessionFile;
  let ctx;
  let consecutiveFailures = 0;
  let degraded = false;

  // Command bridge state (E0-003).
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
    let delivered = false;
    try {
      await postOnce(body);
      delivered = true;
    } catch {
      try {
        await postOnce(body);
        delivered = true;
      } catch (error) {
        log(`event delivery failed: ${errorMessage(error)}`);
      }
    }
    consecutiveFailures = delivered ? 0 : consecutiveFailures + 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      degraded = true;
    }
    return delivered;
  };

  const queue = new SerialDeliveryQueue({
    deliver,
    isDropped: () => degraded,
  });

  const forward = (eventName, payload, currentCtx) => {
    if (!(active && !degraded)) {
      return;
    }
    sessionId = readSessionId(currentCtx) ?? sessionId;
    sessionFile = readSessionFile(currentCtx) ?? sessionFile;
    // Intentionally not awaited: a slow receiver must never stall Pi.
    queue.enqueue(
      JSON.stringify({
        event: eventName,
        instanceId,
        nativeSequence: nextSequence(),
        payload: toJsonSafe(payload),
        sessionFile,
        sessionId,
        timestamp: Date.now(),
      })
    );
  };

  const sendAck = (fields) =>
    queue.enqueue(
      JSON.stringify({
        ...fields,
        instanceId,
        kind: "ack",
        nativeSequence: nextSequence(),
        sessionFile,
        sessionId,
        timestamp: Date.now(),
      })
    );

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

  const isCtxIdle = (currentCtx, whenUnknown) => {
    try {
      return currentCtx.isIdle();
    } catch {
      return whenUnknown;
    }
  };

  const handlePromptCommand = async ({ commandSequence, requestId, text }) => {
    if (typeof text !== "string" || text.trim().length === 0) {
      await rejectCommand(requestId, commandSequence, "empty_text");
      return;
    }
    const currentCtx = ctx;
    if (!(active && currentCtx)) {
      await rejectCommand(requestId, commandSequence, "no_active_session");
      return;
    }
    if (!isCtxIdle(currentCtx, false)) {
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

  const handleAbortCommand = async ({ commandSequence, requestId }) => {
    const currentCtx = ctx;
    if (!(active && currentCtx)) {
      await rejectCommand(requestId, commandSequence, "no_active_session");
      return;
    }
    if (isCtxIdle(currentCtx, true)) {
      await rejectCommand(requestId, commandSequence, "no_active_turn");
      return;
    }
    activeAbort = { commandSequence, requestId };
    try {
      currentCtx.abort();
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
      log(`command handling failed: ${errorMessage(error)}`);
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
        log(`command stream failed: ${errorMessage(error)}`);
      } finally {
        if (commandController === controller) {
          commandController = undefined;
        }
      }
      scheduleCommandReconnect();
    };
    run();
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

  return {
    dispose() {
      active = false;
      ctx = undefined;
      closeCommandStream();
    },
    forward,
    onAgentSettled() {
      finishTurn();
    },
    onAgentStart() {
      if (!(activePrompt && !promptStarted)) {
        return;
      }
      promptStarted = true;
      const { commandSequence, requestId } = activePrompt;
      sendAck({ commandSequence, requestId, status: "started" });
    },
    onMessageEnd(event) {
      if (event?.message?.role === "assistant") {
        lastAssistantStopReason = event.message.stopReason;
      }
    },
    start(currentCtx) {
      active = true;
      // A fresh session may see a recovered receiver; reset the breaker
      // without touching the process-scoped sequence or instance id.
      consecutiveFailures = 0;
      degraded = false;
      ctx = currentCtx;
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
    },
  };
}

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
  let errorLogs = 0;
  let session;

  // Process-scoped monotonic sequence shared by events and acks.
  const nextSequence = () => {
    nativeSequence += 1;
    return nativeSequence;
  };

  const log = (message) => {
    if (errorLogs >= MAX_ERROR_LOGS) {
      return;
    }
    errorLogs += 1;
    try {
      process.stderr.write(`[omo-pi-extension] ${message}\n`);
    } catch {
      // stderr may already be closed during teardown.
    }
  };

  pi.on("session_start", (event, ctx) => {
    const previous = session;
    session = undefined;
    previous?.dispose();
    const next = createSpikeSession({
      commandsUrl,
      eventsUrl,
      instanceId,
      log,
      nextSequence,
      pi,
    });
    session = next;
    next.start(ctx);
    next.forward("session_start", event, ctx);
  });

  pi.on("session_shutdown", (event, ctx) => {
    const current = session;
    if (!current) {
      return;
    }
    current.forward("session_shutdown", event, ctx);
    session = undefined;
    current.dispose();
  });

  // Only registered when the command channel is configured. These handlers
  // turn native lifecycle events into truthful `started` / `completed` acks.
  if (commandsUrl) {
    pi.on("agent_start", () => {
      session?.onAgentStart();
    });
    pi.on("message_end", (event) => {
      session?.onMessageEnd(event);
    });
    pi.on("agent_settled", () => {
      session?.onAgentSettled();
    });
  }

  for (const eventName of STREAM_EVENTS) {
    pi.on(eventName, (event, ctx) => {
      session?.forward(eventName, event, ctx);
    });
  }
}
