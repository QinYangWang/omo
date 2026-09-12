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
  readonly kind: "prompt";
  readonly operationId: string;
  readonly prompt: string;
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
  readonly lane?: string;
  readonly recovery?: boolean;
  readonly type: string;
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
  /** Operations recovered as unfinished when the harness attached. */
  readonly openOperations: () => readonly RuntimeOpenOperation[];
  readonly requestAbort: (operationId: string) => Promise<boolean>;
  readonly sessionId: string;
  readonly watchLane: (
    listener: RuntimeLaneListener,
    lane?: string
  ) => Promise<RuntimeWatchHandle>;
}

export interface AgentRuntime {
  readonly close: () => Promise<void>;
  readonly createSession: (name?: string) => Promise<AgentRuntimeSession>;
  readonly listSessions: () => Promise<readonly RuntimeSessionSummary[]>;
  readonly openSession: (sessionId: string) => Promise<AgentRuntimeSession>;
}
