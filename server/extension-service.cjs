"use strict";

// Private Pi Extension channel (docs/extension-daemon-hybrid.md §5).
//
// This service owns the in-memory native attachment registry and the six
// `/api/v1/extension/*` handlers. It is intentionally transport-agnostic but
// the Host mounts it only on the local Unix socket / Windows named pipe
// listener. Nothing is persisted: credentials, generations and dedup state
// live for the lifetime of one daemon process only.

const { randomBytes, timingSafeEqual } = require("node:crypto");

const CREDENTIAL_BYTES = 32;
const AUTHORIZATION_PATTERN = /^Bearer\s+(.+)$/i;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;
const DEFAULT_SWEEP_INTERVAL_MS = 1000;
const EXTENSION_PATH_PREFIX = "/api/v1/extension/";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
// The frozen contracts require the advertised timings to be >= 1000ms even
// when a test shrinks the daemon-internal timeout below that.
const MIN_ADVERTISED_HEARTBEAT_MS = 1000;
const SSE_HEARTBEAT_MS = 15_000;
const SSE_RETRY_MS = 1000;

const noop = () => undefined;

let contractsPromise = null;

/**
 * Loads the frozen private-channel contracts. `@omo/contracts` is not a
 * direct dependency of the root package, so the workspace-relative dist entry
 * is used as a fallback instead of touching the lockfile or root manifest.
 */
function loadContracts() {
  contractsPromise ??= import("@omo/contracts").catch((error) => {
    if (error && error.code === "ERR_MODULE_NOT_FOUND") {
      return import("../packages/contracts/dist/index.js");
    }
    throw error;
  });
  return contractsPromise;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, Number.MAX_SAFE_INTEGER);
}

function credentialFromRequest(req) {
  const value = req.headers.authorization ?? "";
  if (typeof value !== "string") {
    return "";
  }
  const match = AUTHORIZATION_PATTERN.exec(value.trim());
  return match ? match[1].trim() : "";
}

/**
 * Length-checked constant-time comparison. The length check happens before
 * `timingSafeEqual` because the latter throws on mismatched buffers.
 */
function safeEqual(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string") {
    return false;
  }
  const left = Buffer.from(supplied, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length === 0 || left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

/**
 * Credential-free attachment snapshot. Hooks and other consumers never see
 * the instance credential, so it cannot leak into logs or event payloads.
 */
function attachmentView(attachment) {
  return {
    attachedAt: attachment.attachedAt,
    capabilities: [...attachment.capabilities],
    cwd: attachment.cwd,
    expiresAt: attachment.expiresAt,
    extensionVersion: attachment.extensionVersion,
    generation: attachment.generation,
    instanceId: attachment.instanceId,
    lastHeartbeatAt: attachment.lastHeartbeatAt,
    piVersion: attachment.piVersion,
    sessionFile: attachment.sessionFile,
    sessionId: attachment.sessionId,
  };
}

function parseJsonBody(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new ExtensionChannelError(413, "Request body too large");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed = parseJsonBody(text);
  if (!parsed.ok) {
    throw new ExtensionChannelError(400, "Invalid JSON body");
  }
  return parsed.value;
}

class ExtensionChannelError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ExtensionChannelError";
    this.status = status;
  }
}

function respondError(res, error) {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof ExtensionChannelError) {
    json(res, error.status, { error: error.message });
    return;
  }
  if (error && typeof error.contract === "string") {
    json(res, 400, { error: `Invalid ${error.contract}` });
    return;
  }
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  json(res, status, {
    error: status >= 500 ? "Internal error" : "Bad request",
  });
}

class ExtensionService {
  constructor(options = {}) {
    const {
      canAttach,
      credentialBytes = CREDENTIAL_BYTES,
      heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
      hostId,
      now = Date.now,
      onAck,
      onAttachConfirm,
      onDetach,
      onNativeEvent,
      sseHeartbeatMs = SSE_HEARTBEAT_MS,
      sweepIntervalMs,
    } = options;
    if (typeof hostId !== "string" || hostId.length === 0) {
      throw new Error("ExtensionService requires a hostId");
    }
    this.hostId = hostId;
    this.credentialBytes = positiveInteger(credentialBytes, CREDENTIAL_BYTES);
    this.heartbeatIntervalMs = positiveInteger(
      heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS
    );
    this.heartbeatTimeoutMs = positiveInteger(
      heartbeatTimeoutMs,
      DEFAULT_HEARTBEAT_TIMEOUT_MS
    );
    this.sweepIntervalMs = positiveInteger(
      sweepIntervalMs,
      Math.min(this.heartbeatIntervalMs, DEFAULT_SWEEP_INTERVAL_MS)
    );
    this.sseHeartbeatMs = positiveInteger(sseHeartbeatMs, SSE_HEARTBEAT_MS);
    this.now = now;
    this.onAck = typeof onAck === "function" ? onAck : noop;
    this.onDetach = typeof onDetach === "function" ? onDetach : noop;
    this.onNativeEvent =
      typeof onNativeEvent === "function" ? onNativeEvent : noop;
    // Execution-ownership hooks (design §4). Both are synchronous so the
    // gate -> idle release -> attach-confirm sequence never yields the event
    // loop; see `register`.
    this.canAttach =
      typeof canAttach === "function" ? canAttach : () => ({ ok: true });
    this.onAttachConfirm =
      typeof onAttachConfirm === "function" ? onAttachConfirm : noop;

    // key -> live attachment, sessionId -> current attachment, instanceId ->
    // highest generation seen in this process. Credentials are never kept
    // beyond the attachment lifetime.
    this.attachments = new Map();
    this.currentBySession = new Map();
    this.instances = new Map();
    this.generations = new Map();
    this.subscribers = new Set();
    this.disposed = false;
    this.sweepTimer = setInterval(
      () => this.sweepExpired(),
      this.sweepIntervalMs
    );
    this.sweepTimer.unref?.();
  }

  attachmentKey(instanceId, generation) {
    return `${instanceId}\u0000${generation}`;
  }

  findAttachment(instanceId, generation) {
    const attachment = this.attachments.get(
      this.attachmentKey(instanceId, generation)
    );
    if (!attachment || attachment.released) {
      return;
    }
    // An expired lease is invalid even before the sweep timer observes it.
    if (attachment.expiresAt <= this.now()) {
      this.release(attachment, "heartbeat-timeout");
      return;
    }
    return attachment;
  }

  /**
   * Resolves a live attachment and enforces credential + generation fencing.
   * Fails closed: unknown instance -> 404, stale generation -> 409, wrong or
   * missing credential -> 401.
   */
  authenticate(instanceId, generation, credential) {
    if (typeof credential !== "string" || credential.length === 0) {
      throw new ExtensionChannelError(401, "Unauthorized");
    }
    const attachment = this.findAttachment(instanceId, generation);
    if (attachment) {
      if (!safeEqual(credential, attachment.credential)) {
        throw new ExtensionChannelError(401, "Unauthorized");
      }
      return attachment;
    }
    if (this.instances.has(instanceId)) {
      throw new ExtensionChannelError(409, "Stale generation");
    }
    throw new ExtensionChannelError(404, "Unknown instance");
  }

  release(attachment, reason) {
    if (attachment.released) {
      return;
    }
    attachment.released = true;
    this.attachments.delete(attachment.key);
    if (this.currentBySession.get(attachment.sessionId) === attachment) {
      this.currentBySession.delete(attachment.sessionId);
    }
    this.closeSubscriber(attachment);
    this.onDetach(attachment.sessionId, attachmentView(attachment), reason);
  }

  sweepExpired() {
    if (this.disposed) {
      return;
    }
    const now = this.now();
    for (const attachment of [...this.attachments.values()]) {
      if (attachment.expiresAt <= now) {
        this.release(attachment, "heartbeat-timeout");
      }
    }
  }

  closeSubscriber(attachment) {
    const { subscriber } = attachment;
    if (!subscriber) {
      return;
    }
    attachment.subscriber = null;
    subscriber.close();
  }

  /** Public, credential-free execution ownership view (design §4). */
  executionState(sessionId) {
    const attachment = this.currentBySession.get(sessionId);
    if (!attachment || attachment.released) {
      return { state: "detached" };
    }
    return {
      generation: attachment.generation,
      ownerInstanceId: attachment.instanceId,
      state: "native-attached",
    };
  }

  async register(request) {
    const {
      ExtensionRegisterAcceptedSchema,
      ExtensionRegisterRequestSchema,
      parseContract,
    } = await loadContracts();
    const parsed = parseContract(
      ExtensionRegisterRequestSchema,
      request,
      "ExtensionRegisterRequest"
    );
    const current = this.currentBySession.get(parsed.sessionId);
    if (current && !current.released && current.expiresAt > this.now()) {
      return { ok: false, reason: "session_already_attached" };
    }
    if (current && !current.released) {
      this.release(current, "heartbeat-timeout");
    }
    // Ownership gate: reject before minting a generation. The hook is
    // synchronous and side-effect free so a streaming headless runtime is
    // never disturbed.
    const gate = this.canAttach(parsed.sessionId);
    if (gate && gate.ok === false) {
      return { ok: false, reason: gate.reason };
    }
    // Idle handoff: `onAttachConfirm` synchronously releases an idle headless
    // runtime. There is no `await` between the gate and the confirm below, so
    // a Prompt dispatch cannot interleave and start a second executor.
    try {
      this.onAttachConfirm(parsed.sessionId);
    } catch {
      return { ok: false, reason: "headless_streaming" };
    }
    const generation = (this.generations.get(parsed.sessionId) ?? 0) + 1;
    this.generations.set(parsed.sessionId, generation);
    const issuedAt = this.now();
    const attachment = {
      attachedAt: issuedAt,
      capabilities: [...parsed.capabilities],
      credential: randomBytes(this.credentialBytes).toString("hex"),
      cwd: parsed.cwd,
      expiresAt: issuedAt + this.heartbeatTimeoutMs,
      extensionVersion: parsed.extensionVersion,
      generation,
      instanceId: parsed.instanceId,
      key: this.attachmentKey(parsed.instanceId, generation),
      lastHeartbeatAt: issuedAt,
      piVersion: parsed.piVersion,
      released: false,
      seenNativeSequences: new Set(),
      sessionFile: parsed.sessionFile,
      sessionId: parsed.sessionId,
      subscriber: null,
    };
    this.attachments.set(attachment.key, attachment);
    this.currentBySession.set(parsed.sessionId, attachment);
    this.instances.set(parsed.instanceId, { generation });
    return parseContract(
      ExtensionRegisterAcceptedSchema,
      {
        credential: attachment.credential,
        generation,
        heartbeatIntervalMs: Math.max(
          this.heartbeatIntervalMs,
          MIN_ADVERTISED_HEARTBEAT_MS
        ),
        heartbeatTimeoutMs: Math.max(
          this.heartbeatTimeoutMs,
          MIN_ADVERTISED_HEARTBEAT_MS
        ),
        hostId: this.hostId,
        ok: true,
      },
      "ExtensionRegisterAccepted"
    );
  }

  async heartbeat(request, credential) {
    const { ExtensionHeartbeatRequestSchema, parseContract } =
      await loadContracts();
    const parsed = parseContract(
      ExtensionHeartbeatRequestSchema,
      request,
      "ExtensionHeartbeatRequest"
    );
    const attachment = this.authenticate(
      parsed.instanceId,
      parsed.generation,
      credential
    );
    const refreshedAt = this.now();
    attachment.lastHeartbeatAt = refreshedAt;
    attachment.expiresAt = refreshedAt + this.heartbeatTimeoutMs;
    return {
      expiresAt: attachment.expiresAt,
      generation: attachment.generation,
      ok: true,
    };
  }

  async events(batch, credential) {
    const { ExtensionEventBatchSchema, parseContract } = await loadContracts();
    const parsed = parseContract(
      ExtensionEventBatchSchema,
      batch,
      "ExtensionEventBatch"
    );
    const attachment = this.authenticate(
      parsed.instanceId,
      parsed.generation,
      credential
    );
    for (const event of parsed.events) {
      if (event.sessionId !== attachment.sessionId) {
        throw new ExtensionChannelError(400, "Event session mismatch");
      }
    }
    let accepted = 0;
    let duplicates = 0;
    for (const event of parsed.events) {
      if (attachment.seenNativeSequences.has(event.nativeSequence)) {
        duplicates += 1;
        continue;
      }
      attachment.seenNativeSequences.add(event.nativeSequence);
      accepted += 1;
      this.onNativeEvent(attachmentView(attachment), event);
    }
    return { accepted, duplicates, ok: true };
  }

  async ack(value, credential) {
    const { ExtensionAckSchema, parseContract } = await loadContracts();
    const parsed = parseContract(ExtensionAckSchema, value, "ExtensionAck");
    const attachment = this.authenticate(
      parsed.instanceId,
      parsed.generation,
      credential
    );
    this.onAck(attachmentView(attachment), parsed);
    return { ok: true };
  }

  /**
   * Releases only the exact `(instanceId, generation)` pair. A detach for an
   * already-gone pair is an idempotent no-op and can never release a newer
   * generation.
   */
  async detach(request, credential) {
    const { ExtensionDetachRequestSchema, parseContract } =
      await loadContracts();
    const parsed = parseContract(
      ExtensionDetachRequestSchema,
      request,
      "ExtensionDetachRequest"
    );
    const attachment = this.findAttachment(
      parsed.instanceId,
      parsed.generation
    );
    if (attachment) {
      if (!safeEqual(credential, attachment.credential)) {
        throw new ExtensionChannelError(401, "Unauthorized");
      }
      this.release(attachment, parsed.reason ?? "detached");
      return { ok: true };
    }
    if (credential.length === 0) {
      throw new ExtensionChannelError(401, "Unauthorized");
    }
    const known = this.instances.get(parsed.instanceId);
    if (!known) {
      throw new ExtensionChannelError(404, "Unknown instance");
    }
    if (known.generation > parsed.generation) {
      throw new ExtensionChannelError(409, "Stale generation");
    }
    return { ok: true };
  }

  subscribeCommands(req, res, url) {
    const instanceId = url.searchParams.get("instanceId") ?? "";
    const requestedGeneration = Number(url.searchParams.get("generation"));
    const generation = Number.isInteger(requestedGeneration)
      ? requestedGeneration
      : 0;
    const attachment = this.authenticate(
      instanceId,
      generation,
      credentialFromRequest(req)
    );
    // A reconnect for the same live attachment replaces the previous stream;
    // any other pairing was already rejected above.
    this.closeSubscriber(attachment);

    res.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);

    let closed = false;
    let heartbeat = null;
    const subscriber = {
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(heartbeat);
        this.subscribers.delete(subscriber);
        if (attachment.subscriber === subscriber) {
          attachment.subscriber = null;
        }
        try {
          res.end();
        } catch {
          // The peer already closed the stream.
        }
      },
      isClosed: () => closed,
      write: (command) => {
        if (closed || res.writableEnded || res.destroyed) {
          return false;
        }
        res.write(`data: ${JSON.stringify(command)}\n\n`);
        return true;
      },
    };
    heartbeat = setInterval(() => {
      if (!closed) {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      }
    }, this.sseHeartbeatMs);
    heartbeat.unref?.();

    attachment.subscriber = subscriber;
    this.subscribers.add(subscriber);
    req.on("close", () => subscriber.close());
  }

  /**
   * Writes one command frame to the live subscriber of `sessionId`. Returns
   * false when no subscriber is attached; delivery is never fabricated.
   */
  sendCommand(sessionId, command) {
    const attachment = this.currentBySession.get(sessionId);
    if (!attachment || attachment.released) {
      return false;
    }
    const { subscriber } = attachment;
    if (!subscriber || subscriber.isClosed()) {
      return false;
    }
    return subscriber.write(command);
  }

  async dispatch(req, res, url) {
    const { method } = req;
    const { pathname } = url;
    if (method === "GET" && pathname === `${EXTENSION_PATH_PREFIX}commands`) {
      this.subscribeCommands(req, res, url);
      return true;
    }
    if (method !== "POST") {
      return false;
    }
    if (pathname === `${EXTENSION_PATH_PREFIX}register`) {
      json(res, 200, await this.register(await readJsonBody(req)));
      return true;
    }
    if (pathname === `${EXTENSION_PATH_PREFIX}heartbeat`) {
      json(
        res,
        200,
        await this.heartbeat(
          await readJsonBody(req),
          credentialFromRequest(req)
        )
      );
      return true;
    }
    if (pathname === `${EXTENSION_PATH_PREFIX}events`) {
      json(
        res,
        200,
        await this.events(await readJsonBody(req), credentialFromRequest(req))
      );
      return true;
    }
    if (pathname === `${EXTENSION_PATH_PREFIX}ack`) {
      json(
        res,
        200,
        await this.ack(await readJsonBody(req), credentialFromRequest(req))
      );
      return true;
    }
    if (pathname === `${EXTENSION_PATH_PREFIX}detach`) {
      json(
        res,
        200,
        await this.detach(await readJsonBody(req), credentialFromRequest(req))
      );
      return true;
    }
    return false;
  }

  async handle(req, res, url) {
    if (!url.pathname.startsWith(EXTENSION_PATH_PREFIX)) {
      return false;
    }
    try {
      return await this.dispatch(req, res, url);
    } catch (error) {
      respondError(res, error);
      return true;
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearInterval(this.sweepTimer);
    for (const subscriber of [...this.subscribers]) {
      subscriber.close();
    }
    this.subscribers.clear();
    this.attachments.clear();
    this.currentBySession.clear();
    this.instances.clear();
    this.generations.clear();
  }
}

module.exports = { ExtensionChannelError, ExtensionService };
