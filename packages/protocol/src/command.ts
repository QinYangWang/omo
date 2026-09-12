import { createHash } from "node:crypto";
import type { Static } from "typebox";
import { Type } from "typebox";
import { COMMAND_SCHEMA_VERSION, OMO_PROTOCOL_VERSION } from "./version.ts";

/**
 * Durable command contract (plan §5.4). Every side-effecting request from any
 * client becomes a CommandEnvelope; identity (principal / device) is injected
 * by the daemon's auth context and never trusted from the payload.
 */

export const CommandScopeSchema = Type.Object({
  laneId: Type.Optional(Type.String({ minLength: 1 })),
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
  workspaceId: Type.String({ minLength: 1 }),
});
export type CommandScope = Static<typeof CommandScopeSchema>;

export const CommandEnvelopeSchema = Type.Object({
  /** Client-generated mutation identity used for daemon-side dedup. */
  clientMutationId: Type.String({ minLength: 1 }),
  /** Business operation identity across reconnects. Distinct from requestId. */
  commandId: Type.String({ minLength: 1 }),
  expectedOperationId: Type.Optional(Type.String({ minLength: 1 })),
  /** Optional CAS preconditions (plan §6.6). */
  expectedRevision: Type.Optional(Type.String({ minLength: 1 })),
  /** RFC 3339 timestamp; wire time is always a string, never Date/BigInt. */
  issuedAt: Type.String({ format: "date-time" }),
  kind: Type.String({ minLength: 1 }),
  payload: Type.Unknown(),
  /** sha256 hex of the canonical JSON encoding of `payload`. */
  payloadHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  protocolVersion: Type.Literal(OMO_PROTOCOL_VERSION),
  schemaVersion: Type.Literal(COMMAND_SCHEMA_VERSION),
  scope: CommandScopeSchema,
});
export type CommandEnvelope = Static<typeof CommandEnvelopeSchema>;

/**
 * Command lifecycle (plan §5.4):
 *   received → queued → admitted → running / waiting → completed / failed / cancelled
 * `queued` is the durable receipt state: the command payload, dedup key and
 * stable execution identity can be recovered after a power failure (§5.8).
 */
export const COMMAND_STATES = [
  "received",
  "queued",
  "admitted",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;
export type CommandState = (typeof COMMAND_STATES)[number];
export const CommandStateSchema = Type.Union([
  Type.Literal("received"),
  Type.Literal("queued"),
  Type.Literal("admitted"),
  Type.Literal("running"),
  Type.Literal("waiting"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

const TERMINAL_STATES: ReadonlySet<CommandState> = new Set([
  "cancelled",
  "completed",
  "failed",
]);
export const isTerminalCommandState = (state: CommandState): boolean =>
  TERMINAL_STATES.has(state);

/**
 * Durable acceptance receipt returned to the client only after the command
 * row and its attachments survive a FULL-synchronous commit (plan §5.4 step 2,
 * §5.8). It means "reliably queued", never "the model has started".
 */
export const CommandReceiptSchema = Type.Object({
  commandId: Type.String({ minLength: 1 }),
  /** Daemon durable inbox position, decimal string (plan §6.3 cursor rule). */
  inboxSeq: Type.String({ pattern: "^(0|[1-9][0-9]*)$" }),
  /** Stable execution identity assigned at admission, when applicable. */
  operationId: Type.Optional(Type.String({ minLength: 1 })),
  receivedAt: Type.String({ format: "date-time" }),
  state: CommandStateSchema,
});
export type CommandReceipt = Static<typeof CommandReceiptSchema>;

/** Canonical JSON: sorted object keys, no whitespace, BigInt-free. */
export const canonicalJson = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(normalize);
    }
    if (input !== null && typeof input === "object") {
      const record = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        const item = record[key];
        if (item !== undefined) {
          out[key] = normalize(item);
        }
      }
      return out;
    }
    if (typeof input === "bigint") {
      throw new TypeError(
        "command payloads must not contain BigInt; use decimal strings (plan §6.3)"
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
};

export const hashCommandPayload = (payload: unknown): string =>
  createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");

export interface NewCommandInput {
  clientMutationId: string;
  commandId: string;
  expectedOperationId?: string;
  expectedRevision?: string;
  issuedAt?: string;
  kind: string;
  payload: unknown;
  scope: CommandScope;
}

export const buildCommandEnvelope = (
  input: NewCommandInput
): CommandEnvelope => ({
  clientMutationId: input.clientMutationId,
  commandId: input.commandId,
  expectedOperationId: input.expectedOperationId,
  expectedRevision: input.expectedRevision,
  issuedAt: input.issuedAt ?? new Date().toISOString(),
  kind: input.kind,
  payload: input.payload,
  payloadHash: hashCommandPayload(input.payload),
  protocolVersion: OMO_PROTOCOL_VERSION,
  schemaVersion: COMMAND_SCHEMA_VERSION,
  scope: input.scope,
});
