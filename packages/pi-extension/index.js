import { randomUUID } from "node:crypto";
import {
  buildAckRequest,
  buildCommandStreamPath,
  buildDetachRequest,
  buildEventBatch,
  buildHeartbeatRequest,
  buildNativeEvent,
  buildRegisterRequest,
  checkPiPeerVersion,
  DAEMON_SOCKET_ENV,
  DaemonChannel,
  errorMessage,
  PI_VERSION_ENV,
  readExtensionVersion,
  toJsonSafe,
} from "./daemon-channel.mjs";

const EVENTS_URL_ENV = "OMO_EXTENSION_EVENTS_URL";
const COMMANDS_URL_ENV = "OMO_EXTENSION_COMMANDS_URL";
const REQUEST_TIMEOUT_MS = 1500;
const MAX_ERROR_LOGS = 3;
const MAX_PENDING = 128;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_SEEN_REQUEST_IDS = 1024;
const COMMAND_RECONNECT_ATTEMPTS = 3;
const COMMAND_RECONNECT_BASE_MS = 500;
const DAEMON_PATH_PREFIX = "/api/v1/extension";
const DAEMON_DETACH_TIMEOUT_MS = 1500;
const DAEMON_REREGISTER_ATTEMPTS = 3;
const DAEMON_REREGISTER_BASE_MS = 500;
const DAEMON_HEARTBEAT_FAILURE_LIMIT = 3;
const DAEMON_DEFAULT_HEARTBEAT_MS = 5000;

/**
 * The latest extension factory instance loaded for one `pi` object. Pi always
 * hands a distinct API object to each load, so this is per-extension in
 * production. It also protects the mock/shared case (and the brief window
 * during `/reload` where two instances may coexist): only the newest instance
 * may register, forward or acknowledge, while the superseded instance still
 * releases its own resources on `session_shutdown`.
 */
const currentInstances = new WeakMap();

const extractSseData = (frame) =>
  frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

/**
 * Minimal, shared SSE frame parser for the spike and daemon command streams.
 * Frames are separated by a blank line; only `data:` payloads are handed to
 * `onData`, so comments and keep-alives are ignored. Malformed JSON is the
 * caller's concern and never throws here.
 */
async function readSseStream(stream, onData) {
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
        onData(data);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

/**
 * Native Pi events forwarded to the omo test receiver (E0-002 spike). Keeping
 * this list explicit makes the spike contract auditable against Pi 0.85.0.
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
 * Native Pi events forwarded to the daemon (design §3.1/§7). `session_start`
 * and `session_shutdown` are forwarded explicitly around registration and
 * detach, so they are not part of this loop.
 */
const DAEMON_STREAM_EVENTS = [
  "agent_start",
  "agent_end",
  "agent_settled",
  "message_end",
  "message_start",
  "message_update",
  "model_select",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "session_info_changed",
  "thinking_level_select",
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
    this.idleWaiters = [];
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

  /** Resolves once the queue has no in-flight or pending deliveries. */
  idle() {
    if (!this.draining) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  #finishDrain() {
    this.draining = false;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  async #drain() {
    const entry = this.pending.shift();
    if (entry === undefined) {
      this.#finishDrain();
      return;
    }
    if (this.isDropped?.()) {
      entry.resolve(false);
      this.dropAll();
      this.#finishDrain();
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

  const readCommandStream = async (stream) => {
    await readSseStream(stream, (data) => enqueueCommand(data));
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

/**
 * Per-session daemon attachment (E2-002/E2-003). Owns the register/heartbeat/
 * event forwarding lifecycle plus the private command stream (prompt/abort
 * dispatch and structured acks). Every mutable resource (heartbeat timer,
 * recovery timer, command stream, delivery queue, command dedup state) is
 * created here and released idempotently by `dispose()`. The extension never
 * opens a listening socket: every request goes OUT over the daemon's
 * socketPath.
 */
function createDaemonAttachment({
  cwd,
  extensionVersion,
  instanceId,
  log,
  nextSequence,
  peerCheck,
  pi,
  piVersion,
  sessionFile,
  sessionId,
  socketPath,
}) {
  const channel = new DaemonChannel({ log, socketPath });
  let active = false;
  let attached = false;
  let credential;
  let disposing = false;
  let disposed = false;
  let generation;
  let heartbeatFailures = 0;
  let heartbeatInFlight = false;
  let heartbeatIntervalMs = DAEMON_DEFAULT_HEARTBEAT_MS;
  let heartbeatTimer;
  let recovering = false;
  let recoveryAttempts = 0;
  let recoveryTimer;
  let currentSessionFile = sessionFile;
  let currentSessionId = sessionId;
  // The live session context. Abort/idle checks go through this exact object;
  // it is cleared on dispose so a switched or reloaded session can never be
  // reached through stale state.
  let ctx;

  // --- command stream + prompt/abort dispatch (E2-003) -------------------
  let commandStopped = true;
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
  const commandQueue = [];
  let commandDraining = false;

  function registerBody() {
    return buildRegisterRequest({
      cwd,
      extensionVersion,
      instanceId,
      piVersion,
      sessionFile: currentSessionFile,
      sessionId: currentSessionId,
    });
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    if (disposed || disposing) {
      return;
    }
    heartbeatTimer = setInterval(() => {
      heartbeatTick();
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  function noteHeartbeatFailure() {
    heartbeatFailures += 1;
    if (heartbeatFailures >= DAEMON_HEARTBEAT_FAILURE_LIMIT) {
      beginRecovery();
    }
  }

  async function heartbeatTick() {
    if (
      disposed ||
      disposing ||
      !(attached && generation !== undefined && credential !== undefined) ||
      heartbeatInFlight
    ) {
      return;
    }
    heartbeatInFlight = true;
    try {
      const response = await channel.request(
        `${DAEMON_PATH_PREFIX}/heartbeat`,
        {
          body: buildHeartbeatRequest({ generation, instanceId }),
          credential,
        }
      );
      if (
        response.status >= 200 &&
        response.status < 300 &&
        response.value?.ok === true
      ) {
        heartbeatFailures = 0;
        return;
      }
      if (
        response.status === 401 ||
        response.status === 404 ||
        response.status === 409
      ) {
        beginRecovery();
        return;
      }
      noteHeartbeatFailure();
    } catch {
      noteHeartbeatFailure();
    } finally {
      heartbeatInFlight = false;
    }
  }

  function beginRecovery() {
    if (disposed || disposing || recovering) {
      return;
    }
    recovering = true;
    attached = false;
    stopHeartbeat();
    stopCommandStream();
    forgetInFlightCommands();
    generation = undefined;
    credential = undefined;
    // Events and acks queued for the old generation are dropped: the daemon
    // would reject them anyway, and nothing may be replayed without a new
    // lease.
    queue.dropAll();
    recoveryAttempts = 0;
    scheduleReregister();
  }

  function scheduleReregister() {
    if (disposed || disposing || recoveryTimer) {
      return;
    }
    if (recoveryAttempts >= DAEMON_REREGISTER_ATTEMPTS) {
      log("re-register gave up after 3 attempts");
      recovering = false;
      return;
    }
    recoveryAttempts += 1;
    const delayMs = DAEMON_REREGISTER_BASE_MS * 2 ** (recoveryAttempts - 1);
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      attemptReregister();
    }, delayMs);
    recoveryTimer.unref?.();
  }

  function applyRegistration(value) {
    const {
      credential: nextCredential,
      generation: nextGeneration,
      heartbeatIntervalMs: reportedIntervalMs,
    } = value;
    generation = nextGeneration;
    credential = nextCredential;
    const interval = Number(reportedIntervalMs);
    heartbeatIntervalMs =
      Number.isFinite(interval) && interval > 0
        ? interval
        : DAEMON_DEFAULT_HEARTBEAT_MS;
    attached = true;
    recovering = false;
    recoveryAttempts = 0;
    heartbeatFailures = 0;
    channel.reset();
    startHeartbeat();
    // A new generation restarts command dedup and re-opens the command stream
    // with the freshly minted credential.
    forgetInFlightCommands();
    startCommandStream();
  }

  async function register() {
    let response;
    try {
      response = await channel.request(`${DAEMON_PATH_PREFIX}/register`, {
        body: registerBody(),
      });
    } catch (error) {
      log(`register failed: ${errorMessage(error)}`);
      return false;
    }
    const { status, value } = response;
    if (!(status >= 200 && status < 300) || value?.ok !== true) {
      log(`register rejected: ${value?.reason ?? `http_${status}`}`);
      return false;
    }
    applyRegistration(value);
    return true;
  }

  async function attemptReregister() {
    if (disposed || disposing) {
      return;
    }
    let response;
    try {
      response = await channel.request(`${DAEMON_PATH_PREFIX}/register`, {
        body: registerBody(),
      });
    } catch {
      scheduleReregister();
      return;
    }
    const { status, value } = response;
    if (status >= 200 && status < 300) {
      if (value?.ok === true) {
        applyRegistration(value);
      } else {
        // The daemon is reachable but refused the new lease; retrying cannot
        // help (for example another owner attached first).
        log(`re-register rejected: ${value?.reason ?? "unknown"}`);
        recovering = false;
      }
      return;
    }
    scheduleReregister();
  }

  async function deliver(item) {
    if (item.generation !== generation || credential === undefined) {
      return false;
    }
    const result = await channel.send(item.pathname, {
      body: item.body,
      credential,
    });
    if (result.status === 401 || result.status === 409) {
      beginRecovery();
    }
    return result.delivered;
  }

  const queue = new SerialDeliveryQueue({
    deliver,
    isDropped: () => disposed,
  });

  function forward(eventName, payload, eventCtx) {
    if (!(active && attached) || generation === undefined) {
      // Never buffer events while registration is pending, failed or
      // recovering: the forwarded set is bounded to the live attachment.
      return;
    }
    const sid = readSessionId(eventCtx) ?? currentSessionId;
    if (typeof sid !== "string" || sid.length === 0) {
      return;
    }
    const sfile = readSessionFile(eventCtx) ?? currentSessionFile;
    currentSessionId = sid;
    currentSessionFile = sfile;
    const capturedGeneration = generation;
    // Intentionally not awaited: events and acks share one serialized queue
    // so their delivery order (and the event nativeSequence ordering) is
    // preserved without ever stalling Pi.
    queue.enqueue({
      body: buildEventBatch({
        events: [
          buildNativeEvent({
            event: eventName,
            nativeSequence: nextSequence(),
            payload: toJsonSafe(payload),
            sessionFile: sfile,
            sessionId: sid,
            timestamp: Date.now(),
          }),
        ],
        generation: capturedGeneration,
        instanceId,
      }),
      generation: capturedGeneration,
      pathname: `${DAEMON_PATH_PREFIX}/events`,
    });
  }

  /**
   * Enqueues a frozen `ExtensionAck`. Acks ride the exact same serialized
   * queue as events, so the daemon observes accepted/started/completed in the
   * correct order relative to the native event stream. The captured generation
   * fences the ack: once the attachment re-registers, old-generation acks are
   * dropped by `deliver`.
   */
  function sendAck({ commandSequence, reason, requestId, status }) {
    if (!(active && attached) || generation === undefined) {
      return Promise.resolve(false);
    }
    const capturedGeneration = generation;
    return queue.enqueue({
      body: buildAckRequest({
        commandSequence,
        generation: capturedGeneration,
        instanceId,
        reason,
        requestId,
        status,
      }),
      generation: capturedGeneration,
      pathname: `${DAEMON_PATH_PREFIX}/ack`,
    });
  }

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

  /**
   * Shape/type validation mirroring `ExtensionCommandSchema`. Returns a
   * normalized command or `undefined` for a malformed frame, which is dropped
   * without crashing Pi. An unknown but well-shaped `type` stays a truthful
   * `unknown_command_type` rejection.
   */
  const normalizeCommand = (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const { commandSequence, requestId, type } = value;
    if (typeof requestId !== "string" || requestId.length === 0) {
      return;
    }
    if (!Number.isInteger(commandSequence) || commandSequence < 1) {
      return;
    }
    if (typeof type !== "string" || type.length === 0) {
      return;
    }
    if (type === "prompt" && typeof value.text !== "string") {
      return;
    }
    return { commandSequence, requestId, text: value.text, type };
  };

  const handlePromptCommand = async ({ commandSequence, requestId, text }) => {
    if (text.trim().length === 0) {
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
    activePrompt = { commandSequence, requestId };
    promptStarted = false;
    lastAssistantStopReason = undefined;
    // The accepted ack is queued before dispatch so it always precedes a
    // possible `started`; a synchronous dispatch failure is then rejected.
    await sendAck({ commandSequence, requestId, status: "accepted" });
    try {
      // Native Pi capability (0.85.0): `sendUserMessage` starts a real user
      // turn. A `started` ack is only emitted once `agent_start` actually
      // fires, never optimistically here.
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

  const handleCommand = async (raw) => {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A malformed frame must never crash the Pi session.
      return;
    }
    const command = normalizeCommand(parsed);
    if (!command) {
      return;
    }
    const { commandSequence, requestId, type } = command;
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
    if (type === "prompt") {
      await handlePromptCommand(command);
      return;
    }
    if (type === "abort") {
      await handleAbortCommand(command);
      return;
    }
    await rejectCommand(
      requestId,
      commandSequence,
      `unknown_command_type: ${type}`
    );
  };

  // Commands are processed strictly in arrival order through a serial drain so
  // sequence tracking and acks stay deterministic.
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

  /**
   * Clears per-generation command state. Called whenever the attachment gets
   * a new generation (initial register or recovery) and on dispose: in-flight
   * acks for a dead generation must never be relabelled to the new one.
   */
  function forgetInFlightCommands() {
    activePrompt = undefined;
    promptStarted = false;
    activeAbort = undefined;
    lastAssistantStopReason = undefined;
    lastCommandSequence = 0;
    commandQueue.length = 0;
  }

  /**
   * Handles the HTTP result of one command-stream attempt. Returns whether a
   * bounded reconnect should still be attempted for this run.
   */
  async function handleCommandStreamResult(res, status) {
    if (status === 401 || status === 409) {
      // The generation is dead: stop reconnecting and let the heartbeat
      // recovery path re-register with a fresh generation.
      commandStopped = true;
      res.destroy();
      return false;
    }
    if (status !== 200) {
      res.destroy();
      return true;
    }
    commandAttempts = 0;
    await readSseStream(res, (data) => enqueueCommand(data));
    return true;
  }

  function openCommandStream() {
    if (
      disposed ||
      disposing ||
      commandStopped ||
      commandController ||
      generation === undefined ||
      credential === undefined
    ) {
      return;
    }
    const controller = new AbortController();
    commandController = controller;
    const capturedGeneration = generation;
    const capturedCredential = credential;
    const run = async () => {
      let shouldReconnect = true;
      try {
        const { res, status } = await channel.stream(
          buildCommandStreamPath({
            generation: capturedGeneration,
            instanceId,
          }),
          { credential: capturedCredential, signal: controller.signal }
        );
        shouldReconnect = await handleCommandStreamResult(res, status);
      } catch (error) {
        if (!(controller.signal.aborted || commandStopped)) {
          log(`command stream failed: ${errorMessage(error)}`);
        }
      } finally {
        if (commandController === controller) {
          commandController = undefined;
        }
      }
      if (
        shouldReconnect &&
        !(controller.signal.aborted || commandStopped) &&
        commandController === undefined
      ) {
        scheduleCommandReconnect();
      }
    };
    run();
  }

  function scheduleCommandReconnect() {
    if (disposed || disposing || commandStopped || commandReconnectTimer) {
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
  }

  function stopCommandStream() {
    commandStopped = true;
    if (commandReconnectTimer) {
      clearTimeout(commandReconnectTimer);
      commandReconnectTimer = undefined;
    }
    const controller = commandController;
    commandController = undefined;
    controller?.abort();
  }

  function startCommandStream() {
    if (disposed || disposing) {
      return;
    }
    stopCommandStream();
    commandStopped = false;
    commandAttempts = 0;
    openCommandStream();
  }

  function flushQueue(timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      queue.idle().then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function detach() {
    const detachGeneration = generation;
    const detachCredential = credential;
    generation = undefined;
    credential = undefined;
    if (detachGeneration === undefined || detachCredential === undefined) {
      return;
    }
    try {
      await channel.request(`${DAEMON_PATH_PREFIX}/detach`, {
        body: buildDetachRequest({
          generation: detachGeneration,
          instanceId,
          reason: "session_shutdown",
        }),
        credential: detachCredential,
        timeoutMs: DAEMON_DETACH_TIMEOUT_MS,
      });
    } catch {
      // Best effort: heartbeat expiry releases the attachment on the daemon.
    }
  }

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
    async dispose() {
      if (disposed || disposing) {
        return;
      }
      disposing = true;
      active = false;
      stopHeartbeat();
      stopCommandStream();
      // Clear the live binding before any await: no command may reach a ctx
      // whose session is being torn down.
      ctx = undefined;
      forgetInFlightCommands();
      if (recoveryTimer) {
        clearTimeout(recoveryTimer);
        recoveryTimer = undefined;
      }
      // Deliver the queued session_shutdown before releasing the lease.
      await flushQueue(DAEMON_DETACH_TIMEOUT_MS);
      await detach();
      disposed = true;
      disposing = false;
      queue.dropAll();
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
    async start(currentCtx) {
      if (disposed) {
        return;
      }
      // Bind the live session context before registering so a command that
      // arrives immediately after `register` dispatches to the right runtime.
      ctx = currentCtx;
      active = true;
      if (!peerCheck.ok) {
        log(peerCheck.reason);
        return;
      }
      if (
        typeof currentSessionId !== "string" ||
        currentSessionId.length === 0
      ) {
        log("register skipped: session id unavailable");
        return;
      }
      await register();
    },
  };
}

export default function omoEventForwarder(pi) {
  const eventsUrl = process.env[EVENTS_URL_ENV]?.trim();
  const daemonSocket = process.env[DAEMON_SOCKET_ENV]?.trim();
  if (!(eventsUrl || daemonSocket)) {
    // No receiver and no daemon configured: completely inert (no network, no
    // timers). Daemon mode is inert unless OMO_DAEMON_SOCKET is set.
    return;
  }
  // The spike command channel is only meaningful when acks have somewhere to
  // go. Without OMO_EXTENSION_COMMANDS_URL the E0-002 behavior is unchanged.
  const commandsUrl = process.env[COMMANDS_URL_ENV]?.trim();

  // Latest-instance registry. Pi loads extensions fresh on `/reload` (new API
  // object per load); a newer load supersedes the old one so that, while both
  // are briefly loaded, only the newest registers, forwards or acknowledges.
  const instanceToken = {};
  currentInstances.set(pi, instanceToken);
  const isSuperseded = () => currentInstances.get(pi) !== instanceToken;

  const instanceId = randomUUID();
  // The launcher gates the real Pi version (E0-004); E3 passes OMO_PI_VERSION
  // through. A missing value is recorded as "unknown" rather than guessed.
  const piVersion = process.env[PI_VERSION_ENV]?.trim() || "unknown";
  const peerCheck =
    piVersion === "unknown"
      ? { majorMinor: null, ok: true }
      : checkPiPeerVersion(piVersion);
  const extensionVersion = readExtensionVersion();
  let nativeSequence = 0;
  let errorLogs = 0;
  let spikeSession;
  let daemonSession;

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

  /**
   * Contains every handler error: a throwing handler must never crash Pi.
   * Async handler rejections are logged through the same bounded stderr
   * budget as transport failures.
   */
  const guard = (label, handler) =>
    function guarded(...args) {
      try {
        const result = handler(...args);
        if (result && typeof result.then === "function") {
          return result.catch((error) => {
            log(`${label} failed: ${errorMessage(error)}`);
          });
        }
        return result;
      } catch (error) {
        log(`${label} failed: ${errorMessage(error)}`);
      }
    };

  const on = (eventName, handler) =>
    pi.on(eventName, guard(eventName, handler));

  const forwardToSessions = (eventName, event, ctx) => {
    spikeSession?.forward(eventName, event, ctx);
    daemonSession?.forward(eventName, event, ctx);
  };

  const disposeSessions = async () => {
    const spike = spikeSession;
    spikeSession = undefined;
    spike?.dispose();
    const daemon = daemonSession;
    daemonSession = undefined;
    await daemon?.dispose();
  };

  on("session_start", async (event, ctx) => {
    // A superseded instance (briefly alive during `/reload`) releases its own
    // resources but never registers a second attachment.
    if (isSuperseded()) {
      await disposeSessions();
      return;
    }
    // Defensive: a start without a preceding shutdown must not leak the old
    // session's timers or lease.
    await disposeSessions();
    if (eventsUrl) {
      const next = createSpikeSession({
        commandsUrl,
        eventsUrl,
        instanceId,
        log,
        nextSequence,
        pi,
      });
      spikeSession = next;
      next.start(ctx);
    }
    if (daemonSocket) {
      daemonSession = createDaemonAttachment({
        cwd: typeof ctx?.cwd === "string" ? ctx.cwd : undefined,
        extensionVersion,
        instanceId,
        log,
        nextSequence,
        peerCheck,
        pi,
        piVersion,
        sessionFile: readSessionFile(ctx),
        sessionId: readSessionId(ctx),
        socketPath: daemonSocket,
      });
      await daemonSession.start(ctx);
    }
    forwardToSessions("session_start", event, ctx);
  });

  on("session_shutdown", async (event, ctx) => {
    if (!(spikeSession || daemonSession)) {
      return;
    }
    if (!isSuperseded()) {
      forwardToSessions("session_shutdown", event, ctx);
    }
    await disposeSessions();
  });

  // Only registered when the spike command channel is configured. These
  // handlers turn native lifecycle events into truthful `started` /
  // `completed` acks.
  if (commandsUrl) {
    on("agent_start", () => {
      if (!isSuperseded()) {
        spikeSession?.onAgentStart();
      }
    });
    on("message_end", (event) => {
      if (!isSuperseded()) {
        spikeSession?.onMessageEnd(event);
      }
    });
    on("agent_settled", () => {
      if (!isSuperseded()) {
        spikeSession?.onAgentSettled();
      }
    });
  }

  if (eventsUrl) {
    for (const eventName of STREAM_EVENTS) {
      on(eventName, (event, ctx) => {
        if (!isSuperseded()) {
          spikeSession?.forward(eventName, event, ctx);
        }
      });
    }
  }

  if (daemonSocket) {
    for (const eventName of DAEMON_STREAM_EVENTS) {
      on(eventName, (event, ctx) => {
        if (isSuperseded()) {
          return;
        }
        // One handler per native event forwards it and, for the three ack
        // lifecycle events, drives the truthful `started`/`completed` acks
        // through the same serialized delivery queue.
        daemonSession?.forward(eventName, event, ctx);
        if (eventName === "agent_start") {
          daemonSession?.onAgentStart();
        } else if (eventName === "message_end") {
          daemonSession?.onMessageEnd(event);
        } else if (eventName === "agent_settled") {
          daemonSession?.onAgentSettled();
        }
      });
    }
  }
}
