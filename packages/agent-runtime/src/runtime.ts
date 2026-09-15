import type { AuthResult } from "@earendil-works/pi-ai";

/**
 * omo-owned agent runtime boundary (plan §3.5, §12.2 step 1).
 *
 * The daemon control plane, sync service and clients depend only on these
 * types — never on upstream Harness internals. The v2 implementation
 * (`CoreHarnessRuntime`) adapts `@earendil-works/pi-agent-core`; a legacy v1
 * adapter can implement the same surface during migration.
 */

/** omo-assigned stable operation identity, fixed at command admission (§5.4). */
export interface RuntimeOperationRequest {
  /** Image payloads resolved by the control plane (artifacts → base64). */
  readonly images?: readonly RuntimeImage[];
  readonly kind: "prompt";
  readonly operationId: string;
  readonly prompt: string;
}

export interface RuntimeImage {
  readonly data: string;
  readonly mimeType: string;
}

/** Lane model identity (§6.6: 作用于明确的下一次运行). */
export interface RuntimeModelIdentity {
  readonly modelId: string;
  readonly provider: string;
}

export interface RuntimeProviderInfo {
  readonly authType?: "api_key" | "oauth";
  readonly connected: boolean;
  readonly error?: string;
  readonly hasApiKey: boolean;
  readonly hasOAuth: boolean;
  readonly id: string;
  readonly name: string;
  readonly source?: string;
  readonly subscription: boolean;
}

/** Provider auth callbacks stay in the execution-side runtime. */
export interface RuntimeAuthInteraction {
  readonly notify: (event: import("@earendil-works/pi-ai").AuthEvent) => void;
  readonly prompt: (
    prompt: import("@earendil-works/pi-ai").AuthPrompt
  ) => Promise<string>;
}

export interface RuntimeProviderService {
  /** Resolve request auth inside the execution-side runtime. */
  readonly getAuth: (providerId: string) => Promise<AuthResult | undefined>;
  readonly list: () => Promise<readonly RuntimeProviderInfo[]>;
  readonly login: (
    providerId: string,
    type: import("@earendil-works/pi-ai").AuthType,
    interaction: RuntimeAuthInteraction
  ) => Promise<void>;
  readonly logout: (providerId: string) => Promise<void>;
}

export interface RuntimeAdmission {
  readonly kind: "run";
  readonly operationId: string;
  readonly startedAt: number;
}

export type RuntimeAdmissionError =
  | { readonly code: "lane_busy" }
  | { readonly code: "invalid_message"; readonly message: string }
  | { readonly code: "closed" }
  | { readonly code: "duplicate_operation"; readonly message: string }
  | { readonly code: "runtime_error"; readonly message: string };

export type RuntimeAdmissionResult =
  | { readonly ok: true; readonly value: RuntimeAdmission }
  | { readonly ok: false; readonly error: RuntimeAdmissionError };

export type RuntimeOperationStatus = "running" | "open" | "aborting";

export interface RuntimeOpenOperation {
  readonly aborting: boolean;
  readonly kind: string;
  readonly lane: string;
  readonly operationId: string;
  readonly startedAt: number;
}

export interface RuntimeExecutionInfo {
  readonly current: {
    readonly operationId: string;
    readonly kind: string;
    readonly status: RuntimeOperationStatus;
  } | null;
  readonly lane: string;
  readonly lastOperationId: string | null;
  readonly tipId: string | null;
}

export interface RuntimeOperationResult {
  readonly errorMessage?: string;
  readonly operationId: string;
  readonly status: "completed" | "failed" | "aborted";
}

export type RuntimeDriveOutcome =
  | { readonly kind: "settled"; readonly result: RuntimeOperationResult }
  | {
      readonly kind: "waiting";
      readonly operationId: string;
      readonly reason: "retry" | "deferred";
    };

export type RuntimeDriveResult =
  | { readonly ok: true; readonly value: RuntimeDriveOutcome }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

/** Target-neutral lane snapshot projection for sync clients (§6.4). */
export interface RuntimeLaneSnapshot {
  readonly faulted: boolean;
  readonly lane: string;
  /** Lane's configured model at snapshot time (§6.6 改模型 surface). */
  readonly model?: RuntimeModelIdentity;
  readonly operation: {
    readonly operationId: string;
    readonly kind: string;
    readonly status: RuntimeOperationStatus;
    readonly streamingTextLength: number;
    readonly runningToolCount: number;
  } | null;
  readonly queueLength: number;
  readonly tipId: string | null;
  readonly transcriptLength: number;
}

export interface RuntimeLaneEvent {
  /** Optional upstream event details retained for legacy HTTP projections. */
  readonly details?: unknown;
  readonly lane?: string;
  readonly recovery?: boolean;
  readonly type: string;
}

/**
 * One transcript entry in the history projection (plan §5.7, §6.4). `seq` is
 * the session-local storage sequence; cursors carry it as a DECIMAL STRING
 * (§6.3 cross-language integer rule).
 */
export interface RuntimeHistoryEntry {
  readonly body: unknown;
  readonly customType?: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly seq: number;
  readonly timestamp: number;
  readonly type: string;
}

export interface RuntimeHistoryPage {
  readonly entries: readonly RuntimeHistoryEntry[];
  /** Cursor for the next page; null when this page is the tail. */
  readonly nextCursor: string | null;
}

export interface RuntimeHistoryQuery {
  /** Decimal-string seq cursor; entries strictly after it are returned. */
  readonly cursor?: string;
  readonly limit?: number;
}

export interface RuntimeWatchHandle {
  readonly snapshot: RuntimeLaneSnapshot;
  readonly unsubscribe: () => void;
}

export type RuntimeLaneListener = (
  event: RuntimeLaneEvent,
  snapshot: RuntimeLaneSnapshot
) => void;

export interface RuntimeSessionSummary {
  readonly createdAt: number;
  readonly id: string;
  readonly name?: string;
  readonly storageVersion: number;
}

/**
 * One open Session owned by exactly one Session Worker (§4.1, §5.5). The
 * caller is responsible for single-writer ownership; the runtime refuses a
 * second harness over the same open session by failing `AgentHarness.create`.
 */
export interface AgentRuntimeSession {
  readonly accept: (
    request: RuntimeOperationRequest
  ) => Promise<RuntimeAdmissionResult>;
  readonly close: () => Promise<void>;
  readonly drive: (operationId: string) => Promise<RuntimeDriveResult>;
  readonly getResult: (
    operationId: string
  ) => Promise<RuntimeOperationResult | undefined>;
  readonly inspect: (lane?: string) => Promise<RuntimeExecutionInfo>;
  /** Legacy v1 branch navigation, when the runtime supports it. */
  readonly navigateTree?: (
    targetId: string
  ) => Promise<{ readonly cancelled: boolean }>;
  /** Operations recovered as unfinished when the harness attached. */
  readonly openOperations: () => readonly RuntimeOpenOperation[];
  /**
   * Paginated transcript read (§5.7/§6.4 历史分页投影). Read-only; never
   * mutates the session and never loads more than `limit` entries.
   */
  readonly readHistory: (
    options?: RuntimeHistoryQuery
  ) => Promise<RuntimeHistoryPage>;
  readonly requestAbort: (operationId: string) => Promise<boolean>;
  readonly sessionId: string;
  /** Change the lane's model for the NEXT run boundary (§6.6). */
  readonly setModel: (model: RuntimeModelIdentity) => Promise<void>;
  /** Change the lane's thinking level for the NEXT run boundary. */
  readonly setThinkingLevel: (level: string) => Promise<void>;
  readonly watchLane: (
    listener: RuntimeLaneListener,
    lane?: string
  ) => Promise<RuntimeWatchHandle>;
}

export interface RuntimeModelDescriptor {
  readonly modelId: string;
  readonly name?: string;
  readonly provider: string;
}

export interface AgentRuntime {
  readonly close: () => Promise<void>;
  readonly createSession: (name?: string) => Promise<AgentRuntimeSession>;
  /** Fork one durable session and return the new execution id. */
  readonly forkSession?: (sourceSessionId: string) => Promise<string>;
  /** Provider catalog available to this runtime (§6.6 改模型 choices). */
  readonly listModels: () => readonly RuntimeModelDescriptor[];
  readonly listSessions: () => Promise<readonly RuntimeSessionSummary[]>;
  readonly openSession: (sessionId: string) => Promise<AgentRuntimeSession>;
  /** Provider/auth operations are intentionally execution-side and optional for fakes. */
  readonly providers?: RuntimeProviderService;
  /** Read a closed or active session without attaching a second harness. */
  readonly readSessionHistory?: (
    sessionId: string,
    options?: RuntimeHistoryQuery
  ) => Promise<RuntimeHistoryPage>;
}
