import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type {
  AgentRuntime,
  RuntimeHistoryPage,
  RuntimeHistoryQuery,
  RuntimeImage,
} from "@omo/agent-runtime/runtime";
import type {
  CommandInbox,
  CommandRecord,
  Principal,
} from "@omo/control-plane/inbox";
import type {
  AnswerResult,
  InteractionRecord,
  InteractionStore,
  NewInteraction,
} from "@omo/control-plane/interactions";
import type { CommandReceipt, CommandScope } from "@omo/protocol/command";
import { OmoCommandError } from "@omo/protocol/errors";
import {
  newInteractionId,
  newOperationId,
  newTerminalId,
} from "@omo/protocol/ids";
import type { Static } from "typebox";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { ArtifactStore } from "./artifacts.ts";
import type { DraftPutResult, DraftRecord, DraftStore } from "./drafts.ts";
import { executeFileSave } from "./files.ts";
import type { SessionSupervisor, SessionWorkerSlot } from "./supervisor.ts";
import type { TerminalManager } from "./terminal.ts";
import type { SessionCatalog, WorkspaceRegistry } from "./workspaces.ts";

/**
 * Command service: the P1 assembly core of the modular daemon (plan §4.1,
 * §5.4, §13 P1). It wires the durable inbox, the interaction store and the
 * agent runtime supervisor into one deterministic flow:
 *
 *   submit → schema/scope validation → durable inbox receive (FULL commit)
 *          → 202 receipt → serialized per-session execution
 *          → accept (fixed operation id) → admitted → drive → settle
 *
 * Crash reconciliation (§5.5 recovery order, ADR-003 cross-db rule):
 * startup scans non-terminal commands and re-attaches each to the execution
 * facts of its session:
 *   - operation open in the runtime        → skip accept, drive it;
 *   - operation has a stored result        → complete from the result;
 *   - neither                              → admission never reached disk,
 *                                            re-accept the SAME operation id
 *     (the upstream duplicate-accept hazard only exists for SETTLED ids,
 *     which the previous branch already handles — §3.3.3);
 *   - session.create admitted but session  → outcome_unknown failure
 *     missing (§5.6 conservative rule).
 *
 * Client disconnects never cancel a Run: execution is driven from this
 * service, not from the transport (P1 gate).
 */

export const COMMAND_KINDS = [
  "session.create",
  "session.configure",
  "prompt",
  "operation.abort",
  "file.save",
  "terminal.create",
  "terminal.kill",
  "terminal.control",
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

const PromptPayloadSchema = Type.Object({
  /** Artifact ids to attach as images (resolved + integrity-checked). */
  artifactIds: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), { maxItems: 8 })
  ),
  prompt: Type.String({ minLength: 1 }),
});
const AbortPayloadSchema = Type.Object({
  operationId: Type.String({ minLength: 1 }),
});
const SessionCreatePayloadSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
});
const THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const SessionConfigurePayloadSchema = Type.Object({
  model: Type.Optional(
    Type.Object({
      modelId: Type.String({ minLength: 1 }),
      provider: Type.String({ minLength: 1 }),
    })
  ),
  thinkingLevel: Type.Optional(
    Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))
  ),
});
const FileSavePayloadSchema = Type.Object({
  baseHash: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
  contentBase64: Type.Optional(Type.String()),
  contentText: Type.Optional(Type.String()),
  path: Type.String({ minLength: 1 }),
});
const TerminalCreatePayloadSchema = Type.Object({
  cols: Type.Optional(Type.Integer({ minimum: 2 })),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
  name: Type.Optional(Type.String()),
  rows: Type.Optional(Type.Integer({ minimum: 1 })),
  shell: Type.Optional(Type.String({ minLength: 1 })),
});
const TerminalIdPayloadSchema = Type.Object({
  terminalId: Type.String({ minLength: 1 }),
});
const TerminalControlPayloadSchema = Type.Object({
  action: Type.Union([
    Type.Literal("acquire"),
    Type.Literal("force"),
    Type.Literal("release"),
  ]),
  terminalId: Type.String({ minLength: 1 }),
});

const promptCheck = Compile(PromptPayloadSchema);
const abortCheck = Compile(AbortPayloadSchema);
const sessionCreateCheck = Compile(SessionCreatePayloadSchema);
const sessionConfigureCheck = Compile(SessionConfigurePayloadSchema);
const fileSaveCheck = Compile(FileSavePayloadSchema);
const terminalCreateCheck = Compile(TerminalCreatePayloadSchema);
const terminalIdCheck = Compile(TerminalIdPayloadSchema);
const terminalControlCheck = Compile(TerminalControlPayloadSchema);
const PAYLOAD_CHECKS: Record<CommandKind, (payload: unknown) => boolean> = {
  "file.save": (payload) => fileSaveCheck.Check(payload),
  "operation.abort": (payload) => abortCheck.Check(payload),
  prompt: (payload) => promptCheck.Check(payload),
  "session.configure": (payload) => sessionConfigureCheck.Check(payload),
  "session.create": (payload) => sessionCreateCheck.Check(payload),
  "terminal.control": (payload) => terminalControlCheck.Check(payload),
  "terminal.create": (payload) => terminalCreateCheck.Check(payload),
  "terminal.kill": (payload) => terminalIdCheck.Check(payload),
};

export interface SubmitInput {
  readonly clientMutationId: string;
  readonly commandId: string;
  readonly expectedOperationId?: string;
  readonly expectedRevision?: string;
  readonly issuedAt?: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly scope: CommandScope;
}

export interface CommandServiceOptions {
  readonly artifacts: ArtifactStore;
  readonly catalog: SessionCatalog;
  readonly drafts: DraftStore;
  readonly inbox: CommandInbox;
  readonly interactions: InteractionStore;
  /** Maximum redrive attempts for a `waiting` operation before the command is left for the next restart reconcile (default 600). */
  readonly maxWaitingDrives?: number;
  readonly retryDelayMs?: number;
  readonly runtime: AgentRuntime;
  readonly supervisor: SessionSupervisor;
  /** Diagnostics sink; spans never block or break command paths (§10.3). */
  readonly telemetry?: TelemetryContext;
  readonly terminals: TerminalManager;
  readonly workspaces: WorkspaceRegistry;
}

const DEFAULT_RETRY_DELAY_MS = 100;
const DEFAULT_MAX_WAITING_DRIVES = 600;
const LANE_BUSY_ATTEMPTS = 5;
/** Prompt image attachments budget (§8.3.6 output budgets). */
const MAX_PROMPT_IMAGE_BYTES = 20_971_520;

const isPromptPayload = (
  payload: unknown
): payload is Static<typeof PromptPayloadSchema> =>
  PAYLOAD_CHECKS.prompt(payload);

const WORKSPACE_ONLY_KINDS: readonly CommandKind[] = [
  "file.save",
  "session.create",
  "terminal.control",
  "terminal.create",
  "terminal.kill",
];

/** CAS preconditions (§5.4 wire contract) are honoured or REJECTED (§6.3). */
const validateCasPreconditions = (
  input: SubmitInput,
  kind: CommandKind
): void => {
  if (input.expectedRevision !== undefined) {
    throw new OmoCommandError(
      "payload_schema_unsupported",
      "expectedRevision CAS arrives with the P2 metadata writes"
    );
  }
  if (input.expectedOperationId === undefined) {
    return;
  }
  if (kind !== "operation.abort") {
    throw new OmoCommandError(
      "payload_schema_unsupported",
      "expectedOperationId is only honoured by operation.abort"
    );
  }
  const payload = input.payload as Static<typeof AbortPayloadSchema>;
  if (payload.operationId !== input.expectedOperationId) {
    throw new OmoCommandError(
      "operation_mismatch",
      `expectedOperationId ${input.expectedOperationId} does not match payload operationId ${payload.operationId}`
    );
  }
};

/** The stable execution identity assigned BEFORE the durable receipt (§5.4). */
const assignOperationIdentity = (kind: CommandKind): string | undefined => {
  if (kind === "session.create") {
    return undefined; // assigned at admission: the created session id
  }
  if (kind === "terminal.create") {
    return newTerminalId(); // the receipt directly names the terminal
  }
  return newOperationId();
};

export class CommandService {
  readonly #artifacts: ArtifactStore;
  readonly #catalog: SessionCatalog;
  readonly #drafts: DraftStore;
  readonly #inbox: CommandInbox;
  readonly #interactions: InteractionStore;
  readonly #maxWaitingDrives: number;
  readonly #retryDelayMs: number;
  readonly #runtime: AgentRuntime;
  readonly #supervisor: SessionSupervisor;
  readonly #telemetry?: TelemetryContext;
  readonly #terminals: TerminalManager;
  readonly #workspaces: WorkspaceRegistry;
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #inflight = new Set<Promise<unknown>>();
  readonly #executing = new Set<string>();
  readonly #laneBusyAttempts = new Map<string, number>();
  #closed = false;

  constructor(options: CommandServiceOptions) {
    this.#artifacts = options.artifacts;
    this.#catalog = options.catalog;
    this.#drafts = options.drafts;
    this.#inbox = options.inbox;
    this.#interactions = options.interactions;
    this.#runtime = options.runtime;
    this.#supervisor = options.supervisor;
    this.#telemetry = options.telemetry;
    this.#terminals = options.terminals;
    this.#workspaces = options.workspaces;
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.#maxWaitingDrives =
      options.maxWaitingDrives ?? DEFAULT_MAX_WAITING_DRIVES;
  }

  // ---------------------------------------------------------------- queries

  getCommand(commandId: string): CommandRecord | undefined {
    return this.#inbox.getByCommandId(commandId);
  }

  listCommands(scope: CommandScope): readonly CommandRecord[] {
    return this.#inbox.listByScope(scope);
  }

  getInteraction(interactionId: string): InteractionRecord | undefined {
    return this.#interactions.get(interactionId);
  }

  listPendingInteractions(scope?: CommandScope): readonly InteractionRecord[] {
    return this.#interactions.listPending(scope);
  }

  // ------------------------------------------------------------ drafts (§6.1)

  getDraft(principal: Principal, sessionId: string): DraftRecord | undefined {
    return this.#drafts.get(principal.userId, sessionId);
  }

  putDraft(
    principal: Principal,
    sessionId: string,
    body: string,
    expectedRevision?: number
  ): DraftPutResult {
    return this.#drafts.put(principal, sessionId, body, expectedRevision);
  }

  // ------------------------------------------------------------ history (§5.7)

  /**
   * Paginated transcript projection for sync clients. Reads ride the owning
   * worker's serialized chain so a page never observes a half-committed
   * operation (§6.4 snapshot boundary).
   */
  async readHistory(
    sessionId: string,
    query?: RuntimeHistoryQuery
  ): Promise<RuntimeHistoryPage> {
    const slot = await this.#supervisor.acquire(sessionId);
    return this.#supervisor.runSerialized(slot, () =>
      slot.session.readHistory(query)
    );
  }

  // --------------------------------------------------------------- commands

  /**
   * Validate, durably persist and queue a command. The returned receipt is
   * issued strictly after the inbox FULL-synchronous commit (§5.4 step 2,
   * §5.8); execution continues asynchronously afterwards.
   */
  submit(input: SubmitInput, principal: Principal): CommandReceipt {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated by close()
    if (this.#closed) {
      throw new OmoCommandError(
        "storage_unavailable",
        "command service is closed",
        true
      );
    }
    const kind = input.kind as CommandKind;
    if (!(COMMAND_KINDS as readonly string[]).includes(input.kind)) {
      throw new OmoCommandError(
        "unknown_schema",
        `unknown command kind "${input.kind}"`
      );
    }
    if (!PAYLOAD_CHECKS[kind](input.payload)) {
      throw new OmoCommandError(
        "payload_schema_unsupported",
        `payload for kind "${input.kind}" failed schema validation`
      );
    }
    if (!(WORKSPACE_ONLY_KINDS.includes(kind) || input.scope.sessionId)) {
      throw new OmoCommandError(
        "unknown_schema",
        `command kind "${kind}" requires scope.sessionId`
      );
    }
    // Every command targets a REGISTERED workspace; the scope is a product
    // identity, never a client-supplied path (§10.2).
    if (!this.#workspaces.get(input.scope.workspaceId)) {
      throw new OmoCommandError(
        "unknown_workspace",
        `unknown workspace ${input.scope.workspaceId}`
      );
    }
    // A catalogued session belongs to exactly one workspace.
    if (input.scope.sessionId) {
      const catalogEntry = this.#catalog.get(input.scope.sessionId);
      if (
        catalogEntry &&
        catalogEntry.workspaceId !== input.scope.workspaceId
      ) {
        throw new OmoCommandError(
          "permission_denied",
          `session ${input.scope.sessionId} belongs to workspace ${catalogEntry.workspaceId}`,
          false
        );
      }
    }
    validateCasPreconditions(input, kind);
    const operationId = assignOperationIdentity(kind);
    const receipt = this.#inbox.receive({ ...input, operationId }, principal);
    this.#telemetry
      ?.startSpan(
        {
          attributes: {
            commandId: receipt.commandId,
            kind: input.kind,
            workspaceId: input.scope.workspaceId,
          },
          name: "omo.command.submit",
        },
        (span) => {
          span.addEvent("receipt", { state: receipt.state });
        }
      )
      .catch(() => undefined);
    const record = this.#inbox.getByCommandId(receipt.commandId);
    if (record && !isTerminal(record)) {
      this.#schedule(record.commandId);
    }
    return receipt;
  }

  /** Startup recovery: re-attach every non-terminal command (§5.5). */
  reconcile(): void {
    for (const record of this.#inbox.listActive()) {
      this.#schedule(record.commandId);
    }
  }

  #schedule(commandId: string): void {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated by close()
    if (this.#closed || this.#executing.has(commandId)) {
      return;
    }
    this.#executing.add(commandId);
    const task = Promise.resolve()
      .then(() => this.#runCommand(commandId))
      .catch((error: unknown) => {
        // Execution failures must be recorded, never thrown into the void.
        // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated by close()
        if (!this.#closed) {
          try {
            const record = this.#inbox.getByCommandId(commandId);
            if (record && !isTerminal(record)) {
              this.#inbox.fail(commandId, {
                code:
                  error instanceof OmoCommandError ? error.code : "internal",
                message: (error as Error).message,
              });
            }
          } catch {
            // The database itself is gone; nothing more we can durably do.
          }
        }
      })
      .finally(() => {
        this.#executing.delete(commandId);
        this.#inflight.delete(task);
      });
    this.#inflight.add(task);
  }

  async #runCommand(commandId: string): Promise<void> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated by close()
    if (this.#closed) {
      return;
    }
    const record = this.#inbox.getByCommandId(commandId);
    if (!record || isTerminal(record)) {
      return;
    }
    const execute = async (): Promise<void> => {
      if (record.kind === "prompt") {
        const { sessionId } = record.scope;
        const slot = await this.#supervisor.acquire(sessionId as string);
        await this.#supervisor.runSerialized(slot, () =>
          this.#drivePrompt(slot, record)
        );
        return;
      }
      if (record.kind === "session.create") {
        await this.#runSessionCreate(record);
        return;
      }
      if (record.kind === "session.configure") {
        const { sessionId } = record.scope;
        const slot = await this.#supervisor.acquire(sessionId as string);
        await this.#supervisor.runSerialized(slot, () =>
          this.#runSessionConfigure(slot, record)
        );
        return;
      }
      if (record.kind === "operation.abort") {
        await this.#runAbort(record);
        return;
      }
      if (record.kind === "file.save") {
        this.#runFileSave(record);
        return;
      }
      if (record.kind === "terminal.create") {
        this.#runTerminalCreate(record);
        return;
      }
      if (record.kind === "terminal.kill") {
        this.#runTerminalKill(record);
        return;
      }
      if (record.kind === "terminal.control") {
        this.#runTerminalControl(record);
      }
    };
    if (!this.#telemetry) {
      await execute();
      return;
    }
    const terminal = (): string =>
      this.#inbox.getByCommandId(commandId)?.state ?? "unknown";
    await this.#telemetry.startSpan(
      {
        attributes: { commandId, kind: record.kind },
        name: "omo.command.execute",
      },
      async (span) => {
        try {
          await execute();
          span.setAttributes({ terminalState: terminal() });
        } catch (error) {
          span.setStatus({
            error: {
              message: (error as Error).message,
              name: (error as Error).name,
            },
            status: "error",
          });
          throw error;
        }
      }
    );
  }

  async #drivePrompt(
    slot: SessionWorkerSlot,
    record: CommandRecord
  ): Promise<void> {
    const { commandId } = record;
    const { operationId } = record;
    if (!(operationId && isPromptPayload(record.payload))) {
      this.#inbox.fail(commandId, {
        code: "internal",
        message: "prompt command missing operation id or payload",
      });
      return;
    }
    const { session } = slot;
    let images: RuntimeImage[] = [];
    try {
      images = this.#resolveArtifacts(record.payload.artifactIds);
    } catch (error) {
      this.#inbox.fail(commandId, {
        code: error instanceof OmoCommandError ? error.code : "internal",
        message: (error as Error).message,
      });
      return;
    }
    const admission = await this.#ensureAdmission(
      session,
      commandId,
      operationId,
      record.payload.prompt,
      images
    );
    if (admission !== "admitted") {
      return;
    }
    this.#laneBusyAttempts.delete(commandId);

    // Re-read: a concurrent cancel may have moved the state while we awaited.
    const current = this.#inbox.getByCommandId(commandId);
    if (!current || isTerminal(current)) {
      return;
    }
    if (current.state === "queued" || current.state === "received") {
      this.#inbox.markAdmitted(commandId, operationId);
    }
    this.#inbox.markRunning(commandId);

    const driven = await session.drive(operationId);
    if (!driven.ok) {
      if (driven.error.code === "closed") {
        return; // shutting down; reconcile on next start
      }
      this.#inbox.fail(commandId, {
        code: driven.error.code,
        message: driven.error.message,
      });
      return;
    }
    if (driven.value.kind === "waiting") {
      this.#inbox.markWaiting(commandId);
      this.#redriveWaiting(commandId, 1);
      return;
    }
    this.#settlePrompt(commandId, driven.value.result);
  }

  /**
   * Resolve prompt artifact references to integrity-checked base64 images
   * (§5.8.3 read path). Unknown artifacts fail the command — never silently
   * dropped (§6.3).
   */
  #resolveArtifacts(
    artifactIds: readonly string[] | undefined
  ): RuntimeImage[] {
    if (!(artifactIds && artifactIds.length > 0)) {
      return [];
    }
    const images: RuntimeImage[] = [];
    let totalBytes = 0;
    for (const artifactId of artifactIds) {
      const record = this.#artifacts.get(artifactId);
      if (!record) {
        throw new OmoCommandError(
          "unknown_command",
          `unknown artifact ${artifactId}`
        );
      }
      totalBytes += record.size;
      if (totalBytes > MAX_PROMPT_IMAGE_BYTES) {
        throw new OmoCommandError(
          "quota_exceeded",
          `prompt attachments exceed ${MAX_PROMPT_IMAGE_BYTES} bytes`
        );
      }
      const bytes = this.#artifacts.readBytes(record);
      images.push({
        data: bytes.toString("base64"),
        mimeType: record.mime ?? "application/octet-stream",
      });
    }
    return images;
  }

  /**
   * session.configure: model / thinking changes land on the serialized chain
   * AFTER any in-flight run — the next-run boundary of §6.6 by construction.
   */
  async #runSessionConfigure(
    slot: SessionWorkerSlot,
    record: CommandRecord
  ): Promise<void> {
    const payload = record.payload as Static<
      typeof SessionConfigurePayloadSchema
    >;
    if (record.state === "queued" || record.state === "received") {
      if (!record.operationId) {
        throw new OmoCommandError(
          "internal",
          "session.configure missing its operation id"
        );
      }
      this.#inbox.markAdmitted(record.commandId, record.operationId);
    }
    this.#inbox.markRunning(record.commandId);
    if (payload.model) {
      await slot.session.setModel(payload.model);
    }
    if (payload.thinkingLevel) {
      await slot.session.setThinkingLevel(payload.thinkingLevel);
    }
    this.#inbox.complete(record.commandId, {
      applied: true,
      model: payload.model ?? null,
      thinkingLevel: payload.thinkingLevel ?? null,
    });
  }

  /**
   * Reconcile the command with the execution facts of its session (ADR-003
   * cross-database rule): recover an open admission, complete from a stored
   * result, or accept under the same operation id when neither exists.
   */
  async #ensureAdmission(
    session: SessionWorkerSlot["session"],
    commandId: string,
    operationId: string,
    prompt: string,
    images: readonly RuntimeImage[] = []
  ): Promise<"admitted" | "abandoned" | "retry" | "settled"> {
    const reopened = session
      .openOperations()
      .find((operation) => operation.operationId === operationId);
    if (reopened) {
      return "admitted";
    }
    const prior = await session.getResult(operationId);
    if (prior) {
      // Settled while the daemon was down (§5.6: 绝不再次执行).
      this.#settlePrompt(commandId, prior);
      return "settled";
    }
    const admission = await session.accept({
      images,
      kind: "prompt",
      operationId,
      prompt,
    });
    if (admission.ok) {
      return "admitted";
    }
    if (admission.error.code === "lane_busy") {
      this.#retryLaneBusy(commandId);
      return "retry";
    }
    if (admission.error.code === "closed") {
      // Service is shutting down; the next reconcile resumes.
      return "abandoned";
    }
    this.#inbox.fail(commandId, {
      code: admission.error.code,
      message: "message" in admission.error ? admission.error.message : "",
    });
    return "abandoned";
  }

  #settlePrompt(
    commandId: string,
    result: {
      readonly status: "completed" | "failed" | "aborted";
      readonly errorMessage?: string;
      readonly operationId: string;
    }
  ): void {
    if (result.status === "completed") {
      this.#inbox.complete(commandId, result);
      return;
    }
    if (result.status === "aborted") {
      this.#inbox.cancel(commandId, result);
      return;
    }
    this.#inbox.fail(commandId, {
      code: "runtime_error",
      message: result.errorMessage ?? "operation failed",
    });
  }

  async #runSessionCreate(record: CommandRecord): Promise<void> {
    if (record.operationId) {
      // Previously admitted: operationId is the created session id. Verify
      // the execution fact before confirming completion (§5.6).
      const sessions = await this.#runtime.listSessions();
      if (sessions.some((session) => session.id === record.operationId)) {
        this.#inbox.markRunning(record.commandId);
        this.#inbox.complete(record.commandId, {
          recovered: true,
          sessionId: record.operationId,
        });
        return;
      }
      this.#inbox.fail(record.commandId, {
        code: "outcome_unknown",
        message:
          "session.create was admitted but the session is missing after restart",
      });
      return;
    }
    const payload = record.payload as Static<typeof SessionCreatePayloadSchema>;
    // Crash window note: a death between create and markAdmitted can orphan
    // an empty session; it is detectable (empty transcript) and GC-able.
    const slot = await this.#supervisor.create(payload.name);
    this.#catalog.record({
      name: payload.name,
      sessionId: slot.sessionId,
      workspaceId: record.scope.workspaceId,
    });
    this.#inbox.markAdmitted(record.commandId, slot.sessionId);
    this.#inbox.markRunning(record.commandId);
    this.#inbox.complete(record.commandId, { sessionId: slot.sessionId });
  }

  async #runAbort(record: CommandRecord): Promise<void> {
    const payload = record.payload as Static<typeof AbortPayloadSchema>;
    const { sessionId } = record.scope;
    const slot = await this.#supervisor.acquire(sessionId as string);
    // Abort is a control-plane-local execution: admission is the daemon
    // itself, under the command's own stable operation id (§5.4).
    if (record.state === "queued" || record.state === "received") {
      if (!record.operationId) {
        throw new OmoCommandError(
          "internal",
          "abort command missing its operation id"
        );
      }
      this.#inbox.markAdmitted(record.commandId, record.operationId);
    }
    this.#inbox.markRunning(record.commandId);
    const aborted = await slot.session.requestAbort(payload.operationId);
    this.#inbox.complete(record.commandId, {
      aborted,
      operationId: payload.operationId,
    });
  }

  /**
   * file.save: the durable write protocol lives in files.ts; this method
   * only maps the outcome onto the command state machine. Recovery after a
   * crash re-enters this exact path and is decided from the file's actual
   * content (§5.8.4).
   */
  #runFileSave(record: CommandRecord): void {
    const payload = record.payload as Static<typeof FileSavePayloadSchema>;
    if (record.state === "queued" || record.state === "received") {
      if (!record.operationId) {
        throw new OmoCommandError(
          "internal",
          "file.save command missing its operation id"
        );
      }
      this.#inbox.markAdmitted(record.commandId, record.operationId);
    }
    this.#inbox.markRunning(record.commandId);
    try {
      const outcome = executeFileSave(
        this.#workspaces,
        record.scope.workspaceId,
        payload
      );
      this.#inbox.complete(record.commandId, {
        ...outcome,
        path: payload.path,
      });
    } catch (error) {
      if (error instanceof OmoCommandError) {
        this.#inbox.fail(record.commandId, {
          code: error.code,
          message: error.message,
        });
        return;
      }
      throw error;
    }
  }

  /**
   * terminal.create: the receipt's operationId IS the terminal id, so a
   * crash between spawn and completion reconciles by looking up the durable
   * record — never by spawning a second PTY.
   */
  #runTerminalCreate(record: CommandRecord): void {
    const payload = record.payload as Static<
      typeof TerminalCreatePayloadSchema
    >;
    const { commandId, operationId } = record;
    if (!operationId) {
      throw new OmoCommandError(
        "internal",
        "terminal.create missing its terminal id"
      );
    }
    if (record.state === "queued" || record.state === "received") {
      this.#inbox.markAdmitted(commandId, operationId);
    }
    this.#inbox.markRunning(commandId);
    const existing = this.#terminals.get(operationId);
    if (existing) {
      // Recovery path: the PTY row already exists (spawn happened before the
      // crash). After a daemon restart the child is dead (§8.4) and the
      // startup sweep already marked it orphaned — report the truth.
      this.#inbox.complete(commandId, {
        recovered: true,
        status: existing.status,
        terminalId: existing.terminalId,
      });
      return;
    }
    const cwd = this.#workspaces.resolveExisting(
      record.scope.workspaceId,
      payload.cwd ?? "."
    );
    const shell =
      payload.shell ??
      (process.platform === "win32"
        ? "powershell.exe"
        : (process.env.SHELL ?? "/bin/bash"));
    const terminal = this.#terminals.create({
      cols: payload.cols ?? 120,
      name: payload.name,
      rows: payload.rows ?? 30,
      shell,
      terminalId: operationId,
      workspaceId: record.scope.workspaceId,
      workspacePath: cwd,
    });
    this.#inbox.complete(commandId, {
      status: terminal.status,
      terminalId: terminal.terminalId,
    });
  }

  #runTerminalKill(record: CommandRecord): void {
    const payload = record.payload as Static<typeof TerminalIdPayloadSchema>;
    if (record.state === "queued" || record.state === "received") {
      if (!record.operationId) {
        throw new OmoCommandError(
          "internal",
          "terminal.kill missing its operation id"
        );
      }
      this.#inbox.markAdmitted(record.commandId, record.operationId);
    }
    this.#inbox.markRunning(record.commandId);
    const terminal = this.#terminals.kill(payload.terminalId);
    this.#inbox.complete(record.commandId, {
      status: terminal.status,
      terminalId: terminal.terminalId,
    });
  }

  #runTerminalControl(record: CommandRecord): void {
    const payload = record.payload as Static<
      typeof TerminalControlPayloadSchema
    >;
    if (record.state === "queued" || record.state === "received") {
      if (!record.operationId) {
        throw new OmoCommandError(
          "internal",
          "terminal.control missing its operation id"
        );
      }
      this.#inbox.markAdmitted(record.commandId, record.operationId);
    }
    this.#inbox.markRunning(record.commandId);
    const terminal = this.#terminals.control(
      payload.terminalId,
      record.principal,
      payload.action
    );
    this.#inbox.complete(record.commandId, {
      controllerDeviceId: terminal.controllerDeviceId ?? null,
      terminalId: terminal.terminalId,
    });
  }

  // ------------------------------------------------------------ retry loops

  #retryLaneBusy(commandId: string): void {
    const attempts = (this.#laneBusyAttempts.get(commandId) ?? 0) + 1;
    this.#laneBusyAttempts.set(commandId, attempts);
    if (attempts > LANE_BUSY_ATTEMPTS) {
      this.#inbox.fail(commandId, {
        code: "runtime_error",
        message: "lane stayed busy across bounded retries",
      });
      return;
    }
    this.#defer(commandId, this.#retryDelayMs);
  }

  #redriveWaiting(commandId: string, attempt: number): void {
    if (attempt > this.#maxWaitingDrives) {
      // Leave the command in `waiting`; the next daemon restart reconciles it
      // (§5.6 deferred-request semantics belong to the provider contract).
      return;
    }
    this.#defer(commandId, this.#retryDelayMs);
  }

  #defer(commandId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.#schedule(commandId);
    }, delayMs);
    this.#timers.add(timer);
  }

  // ------------------------------------------------------------ interactions

  /** Persist-first interaction creation (§7.6); projections come later. */
  createInteraction(
    input: Omit<NewInteraction, "interactionId"> & {
      readonly interactionId?: string;
    }
  ): InteractionRecord {
    return this.#interactions.create({
      ...input,
      interactionId: input.interactionId ?? newInteractionId(),
    });
  }

  /** First-writer-wins answer, authorized by the caller's principal (§7.6). */
  answerInteraction(
    interactionId: string,
    principal: Principal,
    answer: unknown,
    expectedRevision?: number
  ): AnswerResult {
    return this.#interactions.answer(
      interactionId,
      principal.userId,
      answer,
      expectedRevision
    );
  }

  // -------------------------------------------------------------- lifecycle

  /** Stop scheduling, clear retry timers and let in-flight drives settle. */
  async close(graceMs = 5000): Promise<void> {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated here
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const timer of this.#timers) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    const drained = Promise.allSettled([...this.#inflight]);
    const { promise: grace, resolve: resolveGrace } =
      Promise.withResolvers<void>();
    const timer = setTimeout(resolveGrace, graceMs);
    try {
      await Promise.race([drained, grace]);
    } finally {
      clearTimeout(timer);
    }
  }
}

const TERMINAL = new Set(["cancelled", "completed", "failed"]);
const isTerminal = (record: CommandRecord): boolean =>
  TERMINAL.has(record.state);
