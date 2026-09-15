import type {
  AgentRuntime,
  AgentRuntimeSession,
  RuntimeAdmissionResult,
  RuntimeDriveResult,
  RuntimeExecutionInfo,
  RuntimeHistoryPage,
  RuntimeHistoryQuery,
  RuntimeLaneListener,
  RuntimeLaneSnapshot,
  RuntimeModelDescriptor,
  RuntimeOpenOperation,
  RuntimeOperationRequest,
  RuntimeOperationResult,
  RuntimeSessionSummary,
  RuntimeWatchHandle,
} from "@omo/agent-runtime/runtime";

/**
 * In-memory AgentRuntime fake mirroring the upstream harness' DURABLE
 * semantics (plan §3.2):
 *  - accepted operations survive "worker restarts" (a fresh FakeRuntime over
 *    the same FakeSessionStore sees them as open operations);
 *  - settled results are durable and queryable by operation id;
 *  - accept is NOT idempotent for settled ids (§3.3.3) and reports lane_busy
 *    for an undriven open operation;
 *  - drive may be scripted per operation, including "hang" (crash window)
 *    and abortable pending drives.
 */

export interface FakeOpenOperation {
  readonly images: readonly { data: string; mimeType: string }[];
  readonly kind: string;
  readonly lane: string;
  readonly operationId: string;
  readonly prompt: string;
  readonly startedAt: number;
}

interface FakeHistoryEntry {
  readonly body: unknown;
  readonly id: string;
  readonly images?: readonly { data: string; mimeType: string }[];
  readonly parentId: string | null;
  readonly seq: number;
  readonly timestamp: number;
  readonly type: string;
}

type FakeListener = (
  event: { readonly type: string },
  snapshot: RuntimeLaneSnapshot
) => void;

export interface FakeSessionState {
  accepts: string[];
  configCalls: {
    model?: { provider: string; modelId: string };
    thinkingLevel?: string;
  }[];
  drives: string[];
  entries: FakeHistoryEntry[];
  listeners: Set<FakeListener>;
  name?: string;
  open: Map<string, FakeOpenOperation>;
  pendingDrives: Map<string, (result: RuntimeOperationResult) => void>;
  results: Map<string, RuntimeOperationResult>;
}

export class FakeSessionStore {
  readonly sessions = new Map<string, FakeSessionState>();
  /** Scriptable settle behavior; default: completed. */
  settle: (operationId: string, prompt: string) => RuntimeOperationResult = (
    operationId
  ) => ({ operationId, status: "completed" });
  /** When true, drive blocks until requestAbort (or forever). */
  hangDrives = false;

  session(sessionId: string): FakeSessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        accepts: [],
        configCalls: [],
        drives: [],
        entries: [],
        listeners: new Set(),
        open: new Map(),
        pendingDrives: new Map(),
        results: new Map(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }
}

class FakeRuntimeSession implements AgentRuntimeSession {
  readonly sessionId: string;
  readonly #state: FakeSessionState;
  readonly #store: FakeSessionStore;
  #closed = false;

  constructor(sessionId: string, store: FakeSessionStore) {
    this.sessionId = sessionId;
    this.#store = store;
    this.#state = store.session(sessionId);
  }

  openOperations(): readonly RuntimeOpenOperation[] {
    // The public recovery shape carries no attachments (runtime contract).
    return [...this.#state.open.values()].map((operation) => ({
      aborting: false,
      kind: operation.kind,
      lane: operation.lane,
      operationId: operation.operationId,
      startedAt: operation.startedAt,
    }));
  }

  accept(request: RuntimeOperationRequest): Promise<RuntimeAdmissionResult> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated by close()
    if (this.#closed) {
      return Promise.resolve({ error: { code: "closed" }, ok: false });
    }
    if (this.#state.open.has(request.operationId)) {
      return Promise.resolve({ error: { code: "lane_busy" }, ok: false });
    }
    this.#state.accepts.push(request.operationId);
    // Note: settled ids are re-accepted on purpose, mirroring §3.3.3.
    this.#state.open.set(request.operationId, {
      images: request.images ?? [],
      kind: "run",
      lane: "main",
      operationId: request.operationId,
      prompt: request.prompt,
      startedAt: Date.now(),
    });
    return Promise.resolve({
      ok: true,
      value: {
        kind: "run",
        operationId: request.operationId,
        startedAt: Date.now(),
      },
    });
  }

  async drive(operationId: string): Promise<RuntimeDriveResult> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated by close()
    if (this.#closed) {
      return { error: { code: "closed", message: "closed" }, ok: false };
    }
    const open = this.#state.open.get(operationId);
    if (!open) {
      return {
        error: {
          code: "operation_mismatch",
          message: `no open operation ${operationId}`,
        },
        ok: false,
      };
    }
    this.#state.drives.push(operationId);
    const notify = (type: string, running: boolean): void => {
      const snapshot: RuntimeLaneSnapshot = {
        faulted: false,
        lane: open.lane,
        operation: running
          ? {
              kind: open.kind,
              operationId,
              runningToolCount: 0,
              status: "running",
              streamingTextLength: 0,
            }
          : null,
        queueLength: this.#state.open.size,
        tipId: `tip_${this.#state.entries.length}`,
        transcriptLength: this.#state.entries.length,
      };
      for (const listener of this.#state.listeners) {
        listener({ type }, snapshot);
      }
    };
    notify("run_start", true);
    const result = await new Promise<RuntimeOperationResult>((resolve) => {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: tests flip it
      if (this.#store.hangDrives) {
        this.#state.pendingDrives.set(operationId, resolve);
        return;
      }
      resolve(this.#store.settle(operationId, open.prompt));
    });
    this.#state.open.delete(operationId);
    this.#state.pendingDrives.delete(operationId);
    this.#state.results.set(operationId, result);
    // Append a user + assistant pair to the fake transcript, mirroring a
    // settled prompt's durable history entries.
    const base = this.#state.entries.length;
    this.#state.entries.push(
      {
        body: { content: open.prompt, role: "user" },
        id: `e_${base + 1}`,
        images: open.images,
        parentId: base === 0 ? null : `e_${base}`,
        seq: base + 1,
        timestamp: Date.now(),
        type: "message",
      },
      {
        body: { content: `reply:${open.prompt}`, role: "assistant" },
        id: `e_${base + 2}`,
        parentId: `e_${base + 1}`,
        seq: base + 2,
        timestamp: Date.now(),
        type: "message",
      }
    );
    notify("run_end", false);
    return { ok: true, value: { kind: "settled", result } };
  }

  readHistory(options?: RuntimeHistoryQuery): Promise<RuntimeHistoryPage> {
    const after = options?.cursor === undefined ? 0 : Number(options.cursor);
    const limit = options?.limit ?? 200;
    const page = this.#state.entries.filter((entry) => entry.seq > after);
    const sliced = page.slice(0, limit);
    return Promise.resolve({
      entries: sliced,
      nextCursor: page.length > limit ? String(sliced.at(-1)?.seq ?? 0) : null,
    });
  }

  getResult(operationId: string): Promise<RuntimeOperationResult | undefined> {
    return Promise.resolve(this.#state.results.get(operationId));
  }

  inspect(lane = "main"): Promise<RuntimeExecutionInfo> {
    const last = [...this.#state.results.keys()].at(-1) ?? null;
    return Promise.resolve({
      current: null,
      lane,
      lastOperationId: last,
      tipId: "tip_fake",
    });
  }

  setModel(model: { provider: string; modelId: string }): Promise<void> {
    this.#state.configCalls.push({ model });
    return Promise.resolve();
  }

  setThinkingLevel(level: string): Promise<void> {
    this.#state.configCalls.push({ thinkingLevel: level });
    return Promise.resolve();
  }

  requestAbort(operationId: string): Promise<boolean> {
    const pending = this.#state.pendingDrives.get(operationId);
    if (pending) {
      pending({ operationId, status: "aborted" });
      return Promise.resolve(true);
    }
    if (this.#state.open.has(operationId)) {
      this.#state.open.delete(operationId);
      this.#state.results.set(operationId, {
        operationId,
        status: "aborted",
      });
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  watchLane(
    listener: RuntimeLaneListener,
    lane = "main"
  ): Promise<RuntimeWatchHandle> {
    const wrapped: FakeListener = (event, snapshot) => {
      listener({ lane, type: event.type }, snapshot);
    };
    this.#state.listeners.add(wrapped);
    return Promise.resolve({
      snapshot: {
        faulted: false,
        lane,
        operation: null,
        queueLength: this.#state.open.size,
        tipId: "tip_fake",
        transcriptLength: this.#state.entries.length,
      },
      unsubscribe: () => {
        this.#state.listeners.delete(wrapped);
      },
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}

export class FakeRuntime implements AgentRuntime {
  readonly store: FakeSessionStore;
  #created = 0;

  constructor(store: FakeSessionStore) {
    this.store = store;
  }

  createSession(name?: string): Promise<AgentRuntimeSession> {
    this.#created += 1;
    const sessionId = `ses_fake_${this.#created}_${Date.now()}`;
    const state = this.store.session(sessionId);
    state.name = name;
    return Promise.resolve(new FakeRuntimeSession(sessionId, this.store));
  }

  openSession(sessionId: string): Promise<AgentRuntimeSession> {
    if (!this.store.sessions.has(sessionId)) {
      return Promise.reject(new Error(`unknown session: ${sessionId}`));
    }
    return Promise.resolve(new FakeRuntimeSession(sessionId, this.store));
  }

  listModels(): readonly RuntimeModelDescriptor[] {
    return [{ modelId: "faux-1", name: "Faux One", provider: "faux" }];
  }

  listSessions(): Promise<readonly RuntimeSessionSummary[]> {
    return Promise.resolve(
      [...this.store.sessions.keys()].map((id) => ({
        createdAt: 0,
        id,
        storageVersion: 1,
      }))
    );
  }

  close(): Promise<void> {
    // Nothing to release; durable state lives in the shared store.
    return Promise.resolve();
  }
}

/** Poll a query until it satisfies a condition (bounded). */
export const waitFor = async <T>(
  query: () => T | undefined,
  timeoutMs = 5000
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let current = query();
  while (current === undefined) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    // biome-ignore lint/performance/noAwaitInLoops: intentional polling
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    current = query();
  }
  return current;
};
