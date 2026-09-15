import {
  AgentHarness,
  type AgentLane,
  BACKGROUND_CONTEXT,
  type Context,
  type AgentHarness as CoreAgentHarness,
  type Entry,
  type HarnessEvent,
  type LaneSnapshot,
  type OpenOperation,
  type OperationResultRecord,
  type Session,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AuthCheck,
  Model,
  Models,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import { SqliteSessionRepo } from "@earendil-works/pi-session-backend-sqlite-node";
import { createDurableSqliteFactory } from "@omo/storage/session-backend";
import type {
  AgentRuntime,
  AgentRuntimeSession,
  RuntimeAdmissionResult,
  RuntimeDriveResult,
  RuntimeExecutionInfo,
  RuntimeHistoryEntry,
  RuntimeHistoryPage,
  RuntimeHistoryQuery,
  RuntimeLaneEvent,
  RuntimeLaneListener,
  RuntimeLaneSnapshot,
  RuntimeModelDescriptor,
  RuntimeModelIdentity,
  RuntimeOpenOperation,
  RuntimeOperationRequest,
  RuntimeOperationResult,
  RuntimeProviderInfo,
  RuntimeProviderService,
  RuntimeSessionSummary,
  RuntimeWatchHandle,
} from "./runtime.ts";

/**
 * `AgentRuntime` backed by the upstream `AgentHarness` (plan §3.2, ADR-002).
 *
 * Scope: one process owns one runtime instance; every open Session is
 * attached to at most one harness (§5.5 single writer). Admission separates
 * `accept` (fixed omo operation id, durable) from `drive` (execution), which
 * is what the control-plane inbox needs for crash-safe reconciliation.
 */

export interface CoreRuntimeOptions {
  readonly context?: Context;
  /** Directory holding one `${sessionId}.sqlite` database per session. */
  readonly directory: string;
  readonly model: Model<Api>;
  readonly models: Models;
  readonly systemPrompt?: string;
}

const DEFAULT_LANE = "main";

/** The backend does not re-export its metadata type; derive it from the repo. */
type SqliteSessionMetadata = Awaited<
  ReturnType<SqliteSessionRepo["list"]>
>[number];

interface TaggedFailure {
  readonly _tag: string;
  readonly message: string;
}

const tagOf = (error: unknown): TaggedFailure => {
  if (
    error !== null &&
    typeof error === "object" &&
    "_tag" in error &&
    typeof (error as { _tag: unknown })._tag === "string"
  ) {
    const failure = error as { _tag: string; message?: unknown };
    return {
      _tag: failure._tag,
      message: typeof failure.message === "string" ? failure.message : "",
    };
  }
  if (error instanceof Error) {
    return { _tag: "Error", message: error.message };
  }
  return { _tag: "Unknown", message: String(error) };
};

const toResultStatus = (
  status: OperationResultRecord["status"]
): RuntimeOperationResult["status"] => {
  if (status === "completed") {
    return "completed";
  }
  if (status === "aborted") {
    return "aborted";
  }
  return "failed";
};

const toRuntimeOperationResult = (
  record: OperationResultRecord
): RuntimeOperationResult => ({
  errorMessage: record.error?.message,
  operationId: record.operationId,
  status: toResultStatus(record.status),
});

const toOpenOperation = (operation: OpenOperation): RuntimeOpenOperation => ({
  aborting: operation.aborting === true,
  kind: operation.kind,
  lane: operation.lane,
  operationId: operation.operationId,
  startedAt: operation.startedAt,
});

/** Project a storage Entry into the target-neutral history DTO (§6.3). */
const toHistoryEntry = (entry: Entry): RuntimeHistoryEntry => {
  const base = {
    customType: entry.customType,
    id: entry.id,
    parentId: entry.parentId,
    seq: entry.seq,
    timestamp: entry.timestamp,
    type: entry.type,
  };
  switch (entry.type) {
    case "message":
      return { ...base, body: entry.message };
    case "compaction":
      return {
        ...base,
        body: {
          retainedTailLength: entry.retainedTail.length,
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
        },
      };
    case "branch_summary":
      return {
        ...base,
        body: { fromId: entry.fromId, summary: entry.summary },
      };
    default:
      return { ...base, body: entry.data };
  }
};

const readHistoryPage = async (
  session: Pick<Session, "findEntries">,
  context: Context,
  options?: RuntimeHistoryQuery
): Promise<RuntimeHistoryPage> => {
  const limit = Math.min(Math.max(options?.limit ?? 200, 1), 1000);
  const afterSeq =
    options?.cursor === undefined ? undefined : Number(options.cursor);
  if (afterSeq !== undefined && !Number.isSafeInteger(afterSeq)) {
    throw new Error(`invalid history cursor: ${options?.cursor}`);
  }
  const entries = await session.findEntries(
    {
      cursor: afterSeq === undefined ? undefined : { seq: afterSeq },
      limit,
      order: "asc",
    },
    context
  );
  return {
    entries: entries.map(toHistoryEntry),
    nextCursor:
      entries.length === limit ? String(entries.at(-1)?.seq ?? 0) : null,
  };
};

const toLaneSnapshot = (snapshot: LaneSnapshot): RuntimeLaneSnapshot => ({
  faulted: snapshot.faulted,
  lane: snapshot.lane,
  model: snapshot.configuration?.model
    ? {
        modelId: snapshot.configuration.model.modelId,
        provider: snapshot.configuration.model.provider,
      }
    : undefined,
  operation: snapshot.operation
    ? {
        kind: snapshot.operation.kind,
        operationId: snapshot.operation.id,
        runningToolCount: snapshot.operation.runningTools.length,
        status: snapshot.operation.status,
        streamingTextLength: snapshot.operation.streamingMessage
          ? JSON.stringify(snapshot.operation.streamingMessage.content).length
          : 0,
      }
    : null,
  queueLength: snapshot.queues.length,
  tipId: snapshot.tipId,
  transcriptLength: snapshot.transcript.length,
});

class CoreRuntimeSession implements AgentRuntimeSession {
  readonly sessionId: string;
  readonly #context: Context;
  readonly #session: Session;
  #harness: CoreAgentHarness | undefined;
  readonly #open: readonly RuntimeOpenOperation[];

  constructor(
    sessionId: string,
    harness: CoreAgentHarness,
    open: readonly OpenOperation[],
    context: Context,
    session: Session
  ) {
    this.sessionId = sessionId;
    this.#harness = harness;
    this.#open = open.map(toOpenOperation);
    this.#context = context;
    this.#session = session;
  }

  openOperations(): readonly RuntimeOpenOperation[] {
    return this.#open;
  }

  readHistory(options?: RuntimeHistoryQuery): Promise<RuntimeHistoryPage> {
    if (!this.#harness) {
      throw new Error("session is closed");
    }
    return readHistoryPage(this.#session, this.#context, options);
  }

  #lane(name: string): Promise<AgentLane> {
    if (!this.#harness) {
      throw new Error("session is closed");
    }
    return this.#harness.lane(name, this.#context);
  }

  async accept(
    request: RuntimeOperationRequest
  ): Promise<RuntimeAdmissionResult> {
    try {
      const lane = await this.#lane(DEFAULT_LANE);
      const result = await lane.accept(
        {
          kind: "prompt",
          operationId: request.operationId,
          prompt: request.prompt,
          ...(request.images && request.images.length > 0
            ? {
                images: request.images.map((image) => ({
                  data: image.data,
                  mimeType: image.mimeType,
                  type: "image" as const,
                })),
              }
            : {}),
        },
        this.#context
      );
      if (!result.ok) {
        const failure = tagOf(result.error);
        if (failure._tag === "LaneBusy") {
          return { error: { code: "lane_busy" }, ok: false };
        }
        if (failure._tag === "InvalidMessage") {
          return {
            error: { code: "invalid_message", message: failure.message },
            ok: false,
          };
        }
        if (failure._tag === "Closed" || failure._tag === "HarnessClosed") {
          return { error: { code: "closed" }, ok: false };
        }
        return {
          error: {
            code: "runtime_error",
            message: `${failure._tag}: ${failure.message}`,
          },
          ok: false,
        };
      }
      return {
        ok: true,
        value: {
          kind: "run",
          operationId: result.value.operationId,
          startedAt: result.value.startedAt,
        },
      };
    } catch (error) {
      const failure = tagOf(error);
      return {
        error: {
          code: "runtime_error",
          message: `${failure._tag}: ${failure.message}`,
        },
        ok: false,
      };
    }
  }

  async drive(operationId: string): Promise<RuntimeDriveResult> {
    try {
      const lane = await this.#lane(DEFAULT_LANE);
      const result = await lane.drive({ operationId }, this.#context);
      if (!result.ok) {
        const failure = tagOf(result.error);
        let code = "runtime_error";
        if (failure._tag === "OperationMismatch") {
          code = "operation_mismatch";
        } else if (
          failure._tag === "Closed" ||
          failure._tag === "HarnessClosed"
        ) {
          code = "closed";
        }
        return {
          error: { code, message: `${failure._tag}: ${failure.message}` },
          ok: false,
        };
      }
      const outcome = result.value;
      if (outcome.kind === "waiting") {
        return {
          ok: true,
          value: {
            kind: "waiting",
            operationId: outcome.operationId,
            reason: outcome.reason,
          },
        };
      }
      return {
        ok: true,
        value: {
          kind: "settled",
          result: toRuntimeOperationResult(outcome.outcome),
        },
      };
    } catch (error) {
      const failure = tagOf(error);
      return {
        error: {
          code: "runtime_error",
          message: `${failure._tag}: ${failure.message}`,
        },
        ok: false,
      };
    }
  }

  async getResult(
    operationId: string
  ): Promise<RuntimeOperationResult | undefined> {
    const lane = await this.#lane(DEFAULT_LANE);
    const record = await lane.getResult(operationId, this.#context);
    return record ? toRuntimeOperationResult(record) : undefined;
  }

  async inspect(lane = DEFAULT_LANE): Promise<RuntimeExecutionInfo> {
    const handle = await this.#lane(lane);
    const info = await handle.inspectExecution(this.#context);
    return {
      current: info.current
        ? {
            kind: info.current.kind,
            operationId: info.current.id,
            status: info.current.status,
          }
        : null,
      lane: info.lane,
      lastOperationId: info.lastOperationId,
      tipId: info.tipId,
    };
  }

  async requestAbort(operationId: string): Promise<boolean> {
    const lane = await this.#lane(DEFAULT_LANE);
    const result = await lane.requestAbort(operationId, this.#context);
    return result.ok;
  }

  async navigateTree(
    targetId: string
  ): Promise<{ readonly cancelled: boolean }> {
    const lane = await this.#lane(DEFAULT_LANE);
    const result = await lane.navigateTree(
      targetId,
      { summarize: false },
      this.#context
    );
    if (!result.ok) {
      throw new Error(`unable to navigate session tree: ${result.error._tag}`);
    }
    return { cancelled: result.value.navigation.status === "aborted" };
  }

  async setModel(model: RuntimeModelIdentity): Promise<void> {
    const lane = await this.#lane(DEFAULT_LANE);
    await lane.setModel(
      { modelId: model.modelId, provider: model.provider },
      this.#context
    );
  }

  async setThinkingLevel(level: string): Promise<void> {
    const lane = await this.#lane(DEFAULT_LANE);
    await lane.setThinkingLevel(level as ThinkingLevel, this.#context);
  }

  async watchLane(
    listener: RuntimeLaneListener,
    lane = DEFAULT_LANE
  ): Promise<RuntimeWatchHandle> {
    const handle = await this.#lane(lane);
    const watch = await handle.watch(this.#context);
    const emit = (event: HarnessEvent): void => {
      const runtimeEvent: RuntimeLaneEvent = {
        details: event,
        lane: "lane" in event ? event.lane : undefined,
        recovery: "recovery" in event ? event.recovery === true : undefined,
        type: event.type,
      };
      listener(runtimeEvent, toLaneSnapshot(watch.snapshot));
    };
    watch.start((event) => {
      emit(event as HarnessEvent);
    });
    return {
      snapshot: toLaneSnapshot(watch.snapshot),
      unsubscribe: () => watch.unsubscribe(),
    };
  }

  async close(): Promise<void> {
    const harness = this.#harness;
    this.#harness = undefined;
    if (harness) {
      await harness.close(this.#context);
    }
  }
}

export class CoreHarnessRuntime implements AgentRuntime {
  readonly #repo: SqliteSessionRepo;
  readonly #models: Models;
  readonly #model: Model<Api>;
  readonly #systemPrompt: string | undefined;
  readonly #context: Context;
  readonly providers: RuntimeProviderService;

  private constructor(options: CoreRuntimeOptions) {
    this.#repo = new SqliteSessionRepo({
      databaseFactory: createDurableSqliteFactory(),
      directory: options.directory,
    });
    this.#models = options.models;
    this.#model = options.model;
    this.#systemPrompt = options.systemPrompt;
    this.#context = options.context ?? BACKGROUND_CONTEXT;
    this.providers = {
      getAuth: (providerId) => this.#models.getAuth(providerId),
      list: () => this.#listProviders(),
      login: (providerId, type, interaction) =>
        this.#models
          .login(providerId, type, {
            notify: interaction.notify,
            prompt: interaction.prompt,
          })
          .then(() => undefined),
      logout: (providerId) => this.#models.logout(providerId),
    };
  }

  #listProviders(): Promise<readonly RuntimeProviderInfo[]> {
    return Promise.all(
      this.#models.getProviders().map(async (provider) => {
        let auth: AuthCheck | undefined;
        let error: string | undefined;
        try {
          auth = await this.#models.checkAuth(provider.id, {
            signal: AbortSignal.timeout(5000),
          });
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        return {
          authType: auth?.type,
          connected: auth !== undefined,
          error,
          hasApiKey: provider.auth.apiKey?.login !== undefined,
          hasOAuth: provider.auth.oauth !== undefined,
          id: provider.id,
          name: provider.name,
          source: auth?.source,
          subscription: provider.auth.oauth?.isSubscription === true,
        };
      })
    );
  }

  static create(options: CoreRuntimeOptions): CoreHarnessRuntime {
    return new CoreHarnessRuntime(options);
  }

  async #attach(session: Session): Promise<CoreRuntimeSession> {
    const { harness, open } = await AgentHarness.create(
      {
        model: this.#model,
        models: this.#models,
        session,
        systemPrompt: this.#systemPrompt ?? "You are a coding assistant.",
      },
      this.#context
    );
    return new CoreRuntimeSession(
      session.metadata.id,
      harness,
      open,
      this.#context,
      session
    );
  }

  async createSession(name?: string): Promise<AgentRuntimeSession> {
    const session = await this.#repo.create(undefined, this.#context);
    const attached = await this.#attach(session);
    if (name !== undefined) {
      await session.setName(name, this.#context);
    }
    return attached;
  }

  async openSession(sessionId: string): Promise<AgentRuntimeSession> {
    const listed = await this.#repo.list(undefined, this.#context);
    const metadata = listed.find(
      (candidate: SqliteSessionMetadata) => candidate.id === sessionId
    );
    if (!metadata) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    const session = await this.#repo.open(metadata, this.#context);
    return this.#attach(session);
  }

  async forkSession(sourceSessionId: string): Promise<string> {
    const listed = await this.#repo.list(undefined, this.#context);
    const source = listed.find(
      (candidate: SqliteSessionMetadata) => candidate.id === sourceSessionId
    );
    if (!source) {
      throw new Error(`unknown session: ${sourceSessionId}`);
    }
    const forked = await this.#repo.fork(
      source,
      { branch: DEFAULT_LANE, scope: "branch" },
      this.#context
    );
    const sessionId = forked.metadata.id;
    await forked.close(this.#context);
    return sessionId;
  }

  async listSessions(): Promise<readonly RuntimeSessionSummary[]> {
    const listed = await this.#repo.list(undefined, this.#context);
    return listed.map((metadata: SqliteSessionMetadata) => ({
      createdAt: metadata.createdAt,
      id: metadata.id,
      storageVersion: metadata.storageVersion,
    }));
  }

  async readSessionHistory(
    sessionId: string,
    options?: RuntimeHistoryQuery
  ): Promise<RuntimeHistoryPage> {
    const listed = await this.#repo.list(undefined, this.#context);
    const metadata = listed.find(
      (candidate: SqliteSessionMetadata) => candidate.id === sessionId
    );
    if (!metadata) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    const session = await this.#repo.open(metadata, this.#context);
    try {
      return await readHistoryPage(session, this.#context, options);
    } finally {
      await session.close(this.#context);
    }
  }

  listModels(): readonly RuntimeModelDescriptor[] {
    return this.#models.getModels().map((model) => ({
      modelId: model.id,
      name: model.name,
      provider: model.provider,
    }));
  }

  async close(): Promise<void> {
    await this.#repo.close(this.#context);
  }
}
