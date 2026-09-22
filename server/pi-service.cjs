"use strict";
const fs = require("node:fs");
const {
  createHistorySnapshot,
  historyPage,
  sessionHistoryMessages,
} = require("./display-messages.cjs");
const { contextDetails } = require("./pi-context.cjs");

const MAX_IMAGE_DATA_LENGTH = 8_000_000;

/**
 * HTTP-mapped service error. `statusCode` is read by the Host request
 * handler; `code` is the stable machine-readable reason surfaced to clients.
 */
class PiServiceError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "PiServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** Native ownership conflicts are reported with a stable, matchable code. */
function nativeAttachedError() {
  const error = new Error("session_native_attached");
  error.code = "session_native_attached";
  return error;
}

/** No in-process Session exists for a native-input stop request. */
function sessionNotFoundError() {
  const error = new Error("session_not_found");
  error.code = "session_not_found";
  return error;
}

/** Latest thinking level persisted in the Session branch, if any. */
function thinkingLevelFromBranch(manager) {
  let thinkingLevel = "off";
  const branch =
    typeof manager?.getBranch === "function" ? manager.getBranch() : [];
  for (const entry of branch) {
    const { thinkingLevel: level, type } = entry ?? {};
    if (type === "thinking_level_change" && level) {
      thinkingLevel = level;
    }
  }
  return thinkingLevel;
}

class PiService {
  constructor(
    eventStore,
    workspace,
    sessionWorkspace,
    runtimeAdapter,
    operationLedger
  ) {
    this.events = eventStore;
    this.workspace = workspace;
    this.sessionWorkspace = sessionWorkspace;
    this.sessions = new Map();
    this.sessionHandles = new Map();
    this.sessionEventIds = new WeakMap();
    this.history = new Map();
    this.fileWatchers = new Map();
    this.authPrompts = new Map();
    this.executionBroker = null;
    // sessionId -> in-flight Prompt count. Set synchronously when a Prompt is
    // accepted and cleared once its dispatch settles, so attach gating fails
    // closed even while `isStreaming` is still false (design §4 rule 3).
    this.pendingPrompts = new Map();
    this.runtimeAdapter = runtimeAdapter
      ? Promise.resolve(runtimeAdapter)
      : import("@omo/pi-runtime").then(
          ({ PiRuntimeAdapter }) => new PiRuntimeAdapter()
        );
    this.operationLedger = operationLedger;
  }

  adapter() {
    return this.runtimeAdapter;
  }

  /**
   * Wires the Session execution broker (design §4). Kept as a setter because
   * the broker needs both this service and ExtensionService, and this service
   * is constructed first.
   */
  setExecutionBroker(broker) {
    this.executionBroker = broker;
  }

  nativeAttached(sessionId) {
    return this.executionBroker?.nativeAttached(sessionId) === true;
  }

  /**
   * Credential-free ownership view for `sessionId` (design §4). Falls back to
   * `headless-owned` when no broker is wired (unit tests, legacy paths),
   * because `open()` serves a headless runtime in that case.
   */
  executionState(sessionId) {
    return (
      this.executionBroker?.executionState(sessionId) ?? {
        state: "headless-owned",
      }
    );
  }

  /** Fails closed when a native Extension currently owns the Session. */
  assertHeadlessOwned(sessionId) {
    if (this.nativeAttached(sessionId)) {
      throw nativeAttachedError();
    }
  }

  /** True while a headless runtime exists or is being created. */
  hasRuntime(sessionId) {
    return this.sessionHandles.has(sessionId) || this.sessions.has(sessionId);
  }

  /**
   * Whether the headless runtime for `sessionId` is busy. A runtime that is
   * still being created counts as streaming, and an accepted Prompt that has
   * not yet settled its dispatch counts too: the broker must fail closed for
   * the whole acceptance -> dispatch window, even while `isStreaming` is still
   * false (design §4 rule 3).
   */
  isRuntimeStreaming(sessionId) {
    if (this.hasPendingPrompt(sessionId)) {
      return true;
    }
    const handle = this.sessionHandles.get(sessionId);
    if (handle) {
      return handle.session.isStreaming === true;
    }
    return this.sessions.has(sessionId);
  }

  /** Marks a Session busy from Prompt acceptance until its dispatch settles. */
  markPromptPending(sessionId) {
    this.pendingPrompts.set(
      sessionId,
      (this.pendingPrompts.get(sessionId) ?? 0) + 1
    );
  }

  /** Clears one pending Prompt mark; safe against underflow. */
  clearPromptPending(sessionId) {
    const count = this.pendingPrompts.get(sessionId);
    if (count === undefined) {
      return;
    }
    if (count <= 1) {
      this.pendingPrompts.delete(sessionId);
      return;
    }
    this.pendingPrompts.set(sessionId, count - 1);
  }

  /** True while an accepted Prompt has not yet settled its dispatch. */
  hasPendingPrompt(sessionId) {
    return (this.pendingPrompts.get(sessionId) ?? 0) > 0;
  }

  /**
   * Releases an idle headless runtime before a native attach takes over.
   *
   * The check and the in-memory teardown run synchronously: by the time this
   * method returns, the runtime is no longer reachable through `sessions`,
   * `sessionHandles` or `history` and its event listener is unsubscribed, so
   * no Prompt dispatch can interleave. Actual adapter/session disposal is
   * scheduled afterwards because it may be asynchronous.
   *
   * Throws when the runtime is streaming; returns undefined when absent.
   */
  releaseIdleRuntime(sessionId) {
    const handle = this.sessionHandles.get(sessionId);
    if (!handle) {
      return;
    }
    if (handle.session.isStreaming || this.hasPendingPrompt(sessionId)) {
      const error = new Error("session_headless_streaming");
      error.code = "session_headless_streaming";
      throw error;
    }
    for (const id of handle.sessionIds) {
      this.sessions.delete(id);
      this.sessionHandles.delete(id);
      this.history.delete(id);
    }
    this.sessionEventIds.delete(handle.session);
    handle.unsubscribe?.();
    handle.unsubscribe = undefined;
    return this.disposeHandle(handle);
  }

  /** Best-effort release of the adapter lease / session; never rejects. */
  async disposeHandle(handle) {
    try {
      if (typeof handle.lease?.release === "function") {
        await handle.lease.release();
        return;
      }
      if (typeof handle.session?.dispose === "function") {
        handle.session.dispose();
      }
    } catch {
      // Ownership has already moved on; disposal failures are not fatal.
    }
  }

  async runtime() {
    return (await this.adapter()).getModelRuntime();
  }

  async ensure(sessionId, cwd, sessionPath) {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }
    this.assertHeadlessOwned(sessionId);
    const creating = (async () => {
      const resolvedCwd = await this.workspace.resolveExisting(cwd);
      const resolvedSessionPath = sessionPath
        ? await this.sessionWorkspace.resolveExisting(sessionPath)
        : undefined;
      const lease = await (await this.adapter()).openSession({
        cwd: resolvedCwd,
        sessionPath: resolvedSessionPath,
      });
      const { session } = lease;
      const eventSessionIds = new Set([sessionId]);
      this.sessionEventIds.set(session, eventSessionIds);
      const unsubscribe = session.subscribe((event) => {
        for (const eventSessionId of eventSessionIds) {
          this.events.append(eventSessionId, event);
        }
      });
      this.sessionHandles.set(sessionId, {
        lease,
        session,
        sessionIds: new Set([sessionId]),
        unsubscribe,
      });
      return session;
    })();
    this.sessions.set(sessionId, creating);
    try {
      const session = await creating;
      const durableSessionId = session.sessionId;
      if (durableSessionId && durableSessionId !== sessionId) {
        this.sessions.set(durableSessionId, creating);
        this.sessionEventIds.get(session)?.add(durableSessionId);
        const handle = this.sessionHandles.get(sessionId);
        if (handle) {
          handle.sessionIds.add(durableSessionId);
          this.sessionHandles.set(durableSessionId, handle);
        }
      }
      // A Session that had no headless runtime just crossed the idle
      // `detached` -> `headless-owned` boundary. The broker emits exactly one
      // observable claim here; a later `ensure` (or a concurrent one) returns
      // the existing runtime at the top of this method and never reaches it.
      this.executionBroker?.headlessClaimed?.(sessionId);
      return session;
    } catch (error) {
      this.sessions.delete(sessionId);
      throw error;
    }
  }

  async open({ sessionId, cwd, sessionPath }) {
    // A brand-new Session arrives without an id. Mint one before any
    // EventStore read or write so the whole call uses one key;
    // `latestSequence(undefined)` used to crash the new-session branch. The
    // response still reports the runtime's durable id once it exists.
    const openSessionId = sessionId || crypto.randomUUID();
    if (sessionPath) {
      const resolvedCwd = await this.workspace.resolveExisting(cwd);
      const resolvedSessionPath =
        await this.sessionWorkspace.resolveExisting(sessionPath);
      this.watchSessionFile(openSessionId, resolvedSessionPath);
      const manager = (await this.adapter()).openSessionDocument(
        resolvedSessionPath
      );
      // A native owner must not be shadowed by a second headless runtime.
      // History is still served from the Session file; live model/context
      // state arrives with native event ingestion (E1-004).
      if (this.nativeAttached(openSessionId)) {
        const history = createHistorySnapshot(sessionHistoryMessages(manager), {
          running: false,
        });
        this.history.set(openSessionId, history);
        return {
          ...historyPage(history),
          contextUsage: null,
          eventSequence: this.events.latestSequence(openSessionId),
          // History-only path: no runtime is created or returned here, so
          // report the broker's current ownership exactly as of this
          // response. Normally `native-attached`; `detached` remains a
          // truthful answer if ownership changed after the branch decision.
          execution: this.executionState(openSessionId),
          isStreaming: false,
          model: null,
          outline: history.metas,
          sessionFile: resolvedSessionPath,
          sessionId: manager.getSessionId(),
          thinkingLevel: thinkingLevelFromBranch(manager),
        };
      }
      const session = await this.ensure(
        openSessionId,
        resolvedCwd,
        resolvedSessionPath
      );
      const { isStreaming } = session;
      const history = createHistorySnapshot(sessionHistoryMessages(manager), {
        running: isStreaming,
      });
      this.history.set(openSessionId, history);
      const page = historyPage(history);
      const turnStartSequence = isStreaming
        ? this.events.latestTurnStartSequence(openSessionId)
        : 0;
      return {
        ...page,
        contextUsage: session.getContextUsage() ?? null,
        eventSequence: this.events.latestSequence(openSessionId),
        // `ensure()` above created or returned the headless runtime, so the
        // response describes the ownership it leaves behind (`headless-owned`)
        // rather than the ownership seen at request entry.
        execution: this.executionState(openSessionId),
        isStreaming,
        model: session.model
          ? {
              id: session.model.id,
              name: session.model.name || session.model.id,
              provider: session.model.provider,
            }
          : null,
        outline: history.metas,
        replayFromSequence: turnStartSequence
          ? Math.max(0, turnStartSequence - 1)
          : undefined,
        sessionFile: resolvedSessionPath,
        sessionId: manager.getSessionId(),
        thinkingLevel: session.thinkingLevel,
      };
    }
    const session = await this.ensure(openSessionId, cwd);
    const { isStreaming } = session;
    const turnStartSequence = isStreaming
      ? this.events.latestTurnStartSequence(openSessionId)
      : 0;
    return {
      contextUsage: session.getContextUsage() ?? null,
      cursor: 0,
      eventSequence: this.events.latestSequence(openSessionId),
      // `ensure()` above created or returned the headless runtime, so the
      // response describes the ownership it leaves behind (`headless-owned`)
      // rather than the ownership seen at request entry.
      execution: this.executionState(openSessionId),
      hasMore: false,
      isStreaming,
      messages: [],
      model: session.model
        ? {
            id: session.model.id,
            name: session.model.name || session.model.id,
            provider: session.model.provider,
          }
        : null,
      replayFromSequence: turnStartSequence
        ? Math.max(0, turnStartSequence - 1)
        : undefined,
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
      thinkingLevel: session.thinkingLevel,
    };
  }

  /** Current context-window usage from the live session, if any. */
  async contextUsage({ sessionId, cwd, sessionPath }) {
    const session = await this.ensure(sessionId, cwd, sessionPath);
    return session.getContextUsage() ?? null;
  }

  /** Effective prompt, tools, resources, and billing totals for a live session. */
  async contextDetails({ sessionId, cwd, sessionPath }) {
    const session = await this.ensure(sessionId, cwd, sessionPath);
    return contextDetails(session);
  }

  /** Notify subscribers when the session JSONL changes on disk (e.g. TUI). */
  watchSessionFile(sessionId, filePath) {
    if (this.fileWatchers.has(filePath)) {
      return;
    }
    let timer;
    let lastSize = 0;
    try {
      lastSize = fs.statSync(filePath).size;
    } catch {
      // File may not exist yet for brand-new sessions.
    }
    let watcher;
    try {
      watcher = fs.watch(filePath, { persistent: false }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          try {
            const { size } = fs.statSync(filePath);
            if (size === lastSize) {
              return;
            }
            lastSize = size;
            // A live native attachment already streams this Session over the
            // Extension channel (design §8). The watcher stays armed as the
            // persistence-calibration signal, but must not duplicate the
            // realtime stream. `lastSize` is advanced above regardless, so a
            // real change after a detach still emits exactly once.
            if (this.nativeAttached(sessionId)) {
              return;
            }
            this.events.append(sessionId, {
              path: filePath,
              type: "omo_session_file",
            });
          } catch {
            // Session file deleted or temporarily unavailable.
          }
        }, 250);
      });
    } catch {
      return;
    }
    watcher.on("error", () => undefined);
    this.fileWatchers.set(filePath, watcher);
  }

  /**
   * Re-read the session file from disk and return entries the client has
   * not seen yet. fromTurn >= 0 means the client should replace everything
   * from that absolute turn onward with `messages`.
   */
  async sync({ sessionId, sessionPath, turnCount, tailItemCount }) {
    const resolvedSessionPath =
      await this.sessionWorkspace.resolveExisting(sessionPath);
    const manager = (await this.adapter()).openSessionDocument(
      resolvedSessionPath
    );
    const history = createHistorySnapshot(sessionHistoryMessages(manager), {
      running: this.sessions.get(sessionId)?.isStreaming ?? false,
    });
    this.history.set(sessionId, history);
    const totalTurns = history.turnStarts.length;
    const knownTurns = Number(turnCount) || 0;
    const knownTailItems = Number(tailItemCount) || 0;
    let fromTurn = -1;
    if (totalTurns > knownTurns) {
      fromTurn = Math.max(0, knownTurns);
    } else if (totalTurns > 0 && totalTurns === knownTurns) {
      const tailStart = history.turnStarts[totalTurns - 1];
      const tailLength = history.items.length - tailStart;
      if (tailLength > knownTailItems) {
        fromTurn = totalTurns - 1;
      }
    }
    const messages =
      fromTurn >= 0 ? history.items.slice(history.turnStarts[fromTurn]) : [];
    return { fromTurn, messages, metas: history.metas, totalTurns };
  }

  historyPage(sessionId, before) {
    const history = this.history.get(sessionId);
    return historyPage(
      history || { items: [], metas: [], turnStarts: [] },
      before
    );
  }

  async deleteSession(sessionPath) {
    const resolvedSessionPath =
      await this.sessionWorkspace.resolveExisting(sessionPath);
    const manager = (await this.adapter()).openSessionDocument(
      resolvedSessionPath
    );
    const sessionId = manager.getSessionId();
    const eventSessionIds = new Set(
      this.sessionHandles.get(sessionId)?.sessionIds ?? [sessionId]
    );
    if (this.nativeAttached(sessionId)) {
      throw new PiServiceError(
        409,
        "session_native_attached",
        "Close the native Pi session before deleting it"
      );
    }
    if (this.hasRuntime(sessionId)) {
      if (this.isRuntimeStreaming(sessionId)) {
        throw new PiServiceError(
          409,
          "session_running",
          "Wait for the session to finish before deleting it"
        );
      }
      await this.releaseIdleRuntime(sessionId);
    }
    const watcher = this.fileWatchers.get(resolvedSessionPath);
    watcher?.close();
    this.fileWatchers.delete(resolvedSessionPath);
    await fs.promises.unlink(resolvedSessionPath);
    this.history.delete(sessionId);
    for (const eventSessionId of eventSessionIds) {
      this.events.deleteSession?.(eventSessionId);
    }
  }

  dispose() {
    for (const watcher of this.fileWatchers.values()) {
      watcher.close();
    }
    this.fileWatchers.clear();
    for (const handle of new Set(this.sessionHandles.values())) {
      handle.unsubscribe?.();
      handle.unsubscribe = undefined;
      this.disposeHandle(handle);
    }
    this.sessionHandles.clear();
    this.sessions.clear();
    this.history.clear();
    this.authPrompts.clear();
    this.pendingPrompts.clear();
    this.executionBroker = null;
  }

  async models() {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    return (await (await this.runtime()).getAvailable()).map((model) => ({
      contextWindow: model.contextWindow,
      id: model.id,
      name: model.name || model.id,
      provider: model.provider,
      reasoning: !!model.reasoning,
      // thinkingLevelMap: missing key = provider default, null = unsupported
      thinkingLevels: model.reasoning
        ? levels.filter(
            (level) =>
              level === "off" || model.thinkingLevelMap?.[level] !== null
          )
        : ["off"],
    }));
  }

  async commands({ sessionId, cwd, sessionPath }) {
    const session = await this.ensure(sessionId, cwd, sessionPath);
    const extensions = session.extensionRunner
      .getRegisteredCommands()
      .map(({ invocationName, description }) => ({
        description,
        name: invocationName,
        source: "extension",
      }));
    const prompts = session.promptTemplates.map(({ name, description }) => ({
      description,
      name,
      source: "prompt",
    }));
    const skills = session.resourceLoader
      .getSkills()
      .skills.map(({ name, description }) => ({
        description,
        name: `skill:${name}`,
        source: "skill",
      }));
    return [...extensions, ...prompts, ...skills];
  }

  async setModel(sessionId, provider, modelId) {
    this.assertHeadlessOwned(sessionId);
    const session = await this.sessions.get(sessionId);
    const model = (await this.runtime()).getModel(provider, modelId);
    if (!(session && model)) {
      throw new Error("Model is not available");
    }
    await session.setModel(model);
  }

  async setThinking(sessionId, level) {
    this.assertHeadlessOwned(sessionId);
    const session = await this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Open a session first");
    }
    session.setThinkingLevel(level);
  }

  async branch(sessionId, entryId) {
    this.assertHeadlessOwned(sessionId);
    const session = await this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Open a session first");
    }
    if (!session.isIdle) {
      throw new Error(
        "Wait for the current response to finish before branching"
      );
    }
    let targetId = entryId;
    if (entryId.startsWith("turn:")) {
      const targetIndex = Number(entryId.slice(5));
      let turnIndex = -1;
      for (const entry of session.sessionManager.getBranch()) {
        if (entry.type === "message" && entry.message?.role === "user") {
          turnIndex += 1;
          if (turnIndex > targetIndex) {
            break;
          }
        }
        if (turnIndex === targetIndex) {
          targetId = entry.id;
        }
      }
    }
    const result = await session.navigateTree(targetId, { summarize: false });
    if (result.cancelled) {
      return { cancelled: true };
    }
    const history = createHistorySnapshot(
      sessionHistoryMessages(session.sessionManager),
      { running: session.isStreaming }
    );
    this.history.set(sessionId, history);
    return {
      ...historyPage(history),
      cancelled: false,
      editorText: result.editorText,
      outline: history.metas,
    };
  }

  async prompt({ sessionId, message, cwd, sessionPath, requestId, images }) {
    // Native routing takes precedence over every headless concern: a Prompt
    // for a native-selected Session must never call `ensure()`. Fail closed
    // when the broker cannot route it at all.
    if (this.nativeAttached(sessionId)) {
      if (typeof this.executionBroker?.dispatchNativeCommand !== "function") {
        throw nativeAttachedError();
      }
      return this.promptNative({ images, message, requestId, sessionId });
    }
    // Mark the Session busy synchronously, before the first `await`: from
    // durable acceptance until the dispatch settles, attach gating must fail
    // closed even while `isStreaming` is still false. Every exit path below
    // clears exactly one mark, so a leaked mark can never block attaches
    // forever (design §4 rule 3).
    this.markPromptPending(sessionId);
    let dispatched = false;
    try {
      const session = await this.ensure(sessionId, cwd, sessionPath);
      if (session.sessionFile) {
        this.watchSessionFile(sessionId, session.sessionFile);
      }
      const operationId = requestId || crypto.randomUUID();
      const result = {
        operationId,
        sessionFile: session.sessionFile,
        sessionId: session.sessionId,
      };
      if (images !== undefined && !Array.isArray(images)) {
        throw new Error("Invalid image attachments");
      }
      if (images && images.length > 8) {
        throw new Error("Too many image attachments");
      }
      const validImages = images?.map((image) => {
        if (
          image?.type !== "image" ||
          typeof image.data !== "string" ||
          typeof image.mimeType !== "string" ||
          !image.mimeType.startsWith("image/") ||
          image.data.length > MAX_IMAGE_DATA_LENGTH
        ) {
          throw new Error("Invalid image attachment");
        }
        return image;
      });
      const options = {
        ...(session.isStreaming ? { streamingBehavior: "followUp" } : {}),
        ...(validImages?.length ? { images: validImages } : {}),
      };
      const failDispatch = (error) => {
        this.events.append(sessionId, {
          message: error instanceof Error ? error.message : String(error),
          type: "omo_error",
        });
      };
      const dispatch = () => {
        dispatched = true;
        // Defense in depth: ownership may have moved to a native attachment
        // between acceptance and this dispatch. The attach gate rejects that
        // window, but the Prompt side must never start a second executor if
        // it happens anyway; surface a safe error instead of fabricating a
        // successful dispatch.
        if (this.nativeAttached(sessionId)) {
          failDispatch(nativeAttachedError());
          this.clearPromptPending(sessionId);
          return;
        }
        let promptResult;
        try {
          promptResult = session.prompt(
            message,
            Object.keys(options).length ? options : undefined
          );
        } catch (error) {
          failDispatch(error);
          this.clearPromptPending(sessionId);
          return;
        }
        // The mark must outlive `prompt()` itself: a dispatch that has been
        // accepted but whose prompt is still running (or whose runtime has not
        // flipped `isStreaming` yet) keeps the Session busy until it settles.
        Promise.resolve(promptResult)
          .catch(failDispatch)
          .finally(() => this.clearPromptPending(sessionId));
      };
      if (this.operationLedger) {
        return await this.operationLedger.accept(operationId, result, dispatch);
      }
      if (requestId) {
        this.events.saveRequest(operationId, result);
      }
      dispatch();
      return result;
    } finally {
      // ensure/validation failure, a ledger dedupe hit, or a ledger that never
      // invoked the captured dispatch would otherwise leak the mark forever.
      if (!dispatched) {
        this.clearPromptPending(sessionId);
      }
    }
  }

  /**
   * Routes a text-only Prompt to the native owner through the broker.
   *
   * Durable acceptance is preserved: the operation result is written exactly
   * once through the ledger and the broker dispatch runs inside that
   * acceptance, so a crash between acceptance and dispatch suppresses the
   * retry instead of fabricating a second executor (same window as headless).
   * A delivery failure is surfaced as an `omo_error` event but the operation
   * stays accepted, because the acceptance is the durable truth.
   *
   * The Extension command contract is text-only, so image payloads are
   * rejected before any dispatch.
   */
  async promptNative({ sessionId, message, requestId, images }) {
    if (
      images !== undefined &&
      !(Array.isArray(images) && images.length === 0)
    ) {
      throw new PiServiceError(
        400,
        "native_prompt_images_unsupported",
        "Native Extension prompts are text-only; image attachments are not supported."
      );
    }
    const operationId = requestId || crypto.randomUUID();
    const result = { operationId, sessionId };
    const dispatch = () => {
      const outcome = this.executionBroker.dispatchNativeCommand(sessionId, {
        requestId: operationId,
        text: message,
        type: "prompt",
      });
      if (!outcome.delivered) {
        this.events.append(sessionId, {
          code: "native_dispatch_unavailable",
          message:
            "The native Extension did not accept the prompt; it may be disconnected.",
          requestId: operationId,
          retryable: true,
          type: "omo_error",
        });
      }
      return Promise.resolve();
    };
    if (this.operationLedger) {
      return await this.operationLedger.accept(operationId, result, dispatch);
    }
    if (requestId) {
      this.events.saveRequest(operationId, result);
    }
    dispatch();
    return result;
  }

  async abort(sessionId) {
    // Native owners are aborted through the private command channel, never by
    // constructing or touching a headless runtime.
    if (this.nativeAttached(sessionId)) {
      if (typeof this.executionBroker?.dispatchNativeCommand !== "function") {
        throw nativeAttachedError();
      }
      const outcome = this.executionBroker.dispatchNativeCommand(sessionId, {
        requestId: crypto.randomUUID(),
        type: "abort",
      });
      if (!outcome.delivered) {
        this.events.append(sessionId, {
          code: "native_dispatch_unavailable",
          message:
            "The native Extension did not accept the abort; it may be disconnected.",
          requestId: outcome.requestId,
          retryable: true,
          type: "omo_error",
        });
      }
      return { sessionId };
    }
    this.assertHeadlessOwned(sessionId);
    await (await this.sessions.get(sessionId))?.abort();
  }

  /**
   * Ctrl+C-equivalent stop for the active native turn.
   *
   * For a native-attached Session this is a best-effort Abort dispatch
   * through the broker and reports delivery as `{ ok }`; for a headless
   * Session it keeps the existing in-process abort behavior, and throws
   * `session_not_found` when there is neither owner.
   */
  async stopNativeInput(sessionId) {
    if (this.nativeAttached(sessionId)) {
      if (typeof this.executionBroker?.dispatchNativeCommand !== "function") {
        throw nativeAttachedError();
      }
      const outcome = this.executionBroker.dispatchNativeCommand(sessionId, {
        requestId: crypto.randomUUID(),
        type: "abort",
      });
      if (!outcome.delivered) {
        this.events.append(sessionId, {
          code: "native_dispatch_unavailable",
          message:
            "The native Extension did not accept the stop request; it may be disconnected.",
          requestId: outcome.requestId,
          retryable: true,
          type: "omo_error",
        });
      }
      return { ok: outcome.delivered };
    }
    const session = await this.sessions.get(sessionId);
    if (!session) {
      throw sessionNotFoundError();
    }
    await session.abort();
    return { ok: true };
  }

  async providers() {
    const runtime = await this.runtime();
    return Promise.all(
      runtime.getProviders().map(async (provider) => {
        let auth;
        let error;
        try {
          auth = await runtime.checkAuth(provider.id, {
            signal: AbortSignal.timeout(5000),
          });
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        return {
          authType: auth?.type,
          connected: !!auth,
          error,
          hasApiKey: !!provider.auth.apiKey?.login,
          hasOAuth: !!provider.auth.oauth,
          id: provider.id,
          name: provider.name,
          source: auth?.source,
          subscription: !!provider.auth.oauth?.isSubscription,
        };
      })
    );
  }

  async login(providerId, type) {
    const runtime = await this.runtime();
    await runtime.login(providerId, type, {
      notify: (event) =>
        this.events.append("__providers", {
          event,
          kind: "notify",
          providerId,
        }),
      prompt: (prompt) => {
        const deviceCodeOption = prompt.options?.find((option) =>
          ["device_code", "device-code"].includes(option.id)
        );
        if (prompt.type === "select" && deviceCodeOption) {
          this.events.append("__providers", {
            event: {
              message:
                "Using device-code OAuth so the browser can return to this server.",
              type: "info",
            },
            kind: "notify",
            providerId,
          });
          return Promise.resolve(deviceCodeOption.id);
        }
        const requestId = crypto.randomUUID();
        this.events.append("__providers", {
          kind: "prompt",
          prompt: { ...prompt, signal: undefined },
          providerId,
          requestId,
        });
        return new Promise((resolve, reject) =>
          this.authPrompts.set(requestId, { reject, resolve })
        );
      },
    });
    return true;
  }

  respond(requestId, value) {
    const pending = this.authPrompts.get(requestId);
    if (!pending) {
      return false;
    }
    this.authPrompts.delete(requestId);
    pending.resolve(value);
    return true;
  }

  cancel(requestId) {
    const pending = this.authPrompts.get(requestId);
    if (!pending) {
      return false;
    }
    this.authPrompts.delete(requestId);
    pending.reject(new Error("Authentication cancelled"));
    return true;
  }

  async logout(providerId) {
    await (await this.runtime()).logout(providerId);
    return true;
  }
}

module.exports = { PiService, PiServiceError };
