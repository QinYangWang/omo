import type { DatabaseSync } from "node:sqlite";
import {
  buildCommandEnvelope,
  type CommandEnvelope,
  type CommandReceipt,
  type CommandScope,
  type CommandState,
  canonicalJson,
  isTerminalCommandState,
} from "@omo/protocol/command";
import { OmoCommandError } from "@omo/protocol/errors";
import {
  type DurabilityReport,
  readDurabilityReport,
} from "@omo/storage/durability";
import { openDurableDatabase } from "@omo/storage/durable-database";

/**
 * Durable command inbox (plan §5.4, ADR-003).
 *
 * Guarantees:
 *  - Dedup key binds principal + scope + clientMutationId. A replayed command
 *    with the same payload returns the ORIGINAL receipt (same commandId and
 *    inboxSeq); the same key with a different payload is rejected, never
 *    answered with another call's success.
 *  - The receipt is returned only after the insert transaction commits on a
 *    WAL + synchronous=FULL connection, i.e. `202 queued` is recoverable
 *    after power loss (§5.8).
 *  - State transitions follow received → queued → admitted → running /
 *    waiting → completed / failed / cancelled and are enforced in the same
 *    row update, so a crash can never move a command backwards.
 *
 * This module is synchronous (`node:sqlite`); the daemon must run it on a
 * control-plane worker so disk latency cannot block auth/cancel/heartbeat
 * paths (§8.5.5).
 */

export interface Principal {
  readonly deviceId: string;
  readonly userId: string;
}

export interface CommandRecord {
  readonly commandId: string;
  readonly createdAt: string;
  readonly error?: unknown;
  readonly inboxSeq: string;
  readonly kind: string;
  readonly operationId?: string;
  readonly payload: unknown;
  readonly payloadHash: string;
  readonly principal: Principal;
  readonly result?: unknown;
  readonly scope: CommandScope;
  readonly state: CommandState;
  readonly updatedAt: string;
}

export interface ReceiveInput {
  readonly clientMutationId: string;
  readonly commandId: string;
  readonly issuedAt?: string;
  readonly kind: string;
  /** Stable execution identity assigned up front when the kind has one. */
  readonly operationId?: string;
  readonly payload: unknown;
  readonly scope: CommandScope;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS commands (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL UNIQUE,
  dedup_key TEXT NOT NULL UNIQUE,
  principal_user TEXT NOT NULL,
  principal_device TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  operation_id TEXT,
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS commands_scope ON commands(scope_json, seq);
CREATE UNIQUE INDEX IF NOT EXISTS commands_operation
  ON commands(operation_id) WHERE operation_id IS NOT NULL;
`;

const TRANSITIONS: Readonly<Record<CommandState, readonly CommandState[]>> = {
  admitted: ["cancelled", "failed", "running", "waiting"],
  cancelled: [],
  completed: [],
  failed: [],
  queued: ["admitted", "cancelled"],
  received: ["cancelled", "queued"],
  running: ["cancelled", "completed", "failed", "waiting"],
  waiting: ["cancelled", "failed", "running"],
};

interface CommandRow {
  command_id: string;
  created_at: string;
  error_json: string | null;
  kind: string;
  operation_id: string | null;
  payload_hash: string;
  payload_json: string;
  principal_device: string;
  principal_user: string;
  result_json: string | null;
  scope_json: string;
  seq: number;
  state: CommandState;
  updated_at: string;
}

const dedupKeyOf = (
  principal: Principal,
  scope: CommandScope,
  mutationId: string
): string =>
  [
    principal.userId,
    principal.deviceId,
    scope.workspaceId,
    scope.sessionId ?? "-",
    scope.laneId ?? "-",
    mutationId,
  ].join("/");

const rowToRecord = (row: CommandRow): CommandRecord => ({
  commandId: row.command_id,
  createdAt: row.created_at,
  error: row.error_json === null ? undefined : JSON.parse(row.error_json),
  inboxSeq: String(row.seq),
  kind: row.kind,
  operationId: row.operation_id ?? undefined,
  payload: JSON.parse(row.payload_json),
  payloadHash: row.payload_hash,
  principal: {
    deviceId: row.principal_device,
    userId: row.principal_user,
  },
  result: row.result_json === null ? undefined : JSON.parse(row.result_json),
  scope: JSON.parse(row.scope_json),
  state: row.state,
  updatedAt: row.updated_at,
});

const toReceipt = (record: CommandRecord): CommandReceipt => ({
  commandId: record.commandId,
  inboxSeq: record.inboxSeq,
  operationId: record.operationId,
  receivedAt: record.createdAt,
  state: record.state,
});

export class CommandInbox {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static open(path: string): CommandInbox {
    const { db } = openDurableDatabase(path);
    db.exec(SCHEMA);
    return new CommandInbox(db);
  }

  /**
   * Atomically dedup + persist a command and return its durable receipt.
   * Idempotent for client retries of the same mutation; rejects payload
   * changes under an existing dedup key.
   */
  receive(input: ReceiveInput, principal: Principal): CommandReceipt {
    const envelope: CommandEnvelope = buildCommandEnvelope({
      clientMutationId: input.clientMutationId,
      commandId: input.commandId,
      issuedAt: input.issuedAt,
      kind: input.kind,
      payload: input.payload,
      scope: input.scope,
    });
    const dedupKey = dedupKeyOf(principal, input.scope, input.clientMutationId);
    const now = new Date().toISOString();

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#db
        .prepare("SELECT * FROM commands WHERE dedup_key = ?")
        .get(dedupKey) as CommandRow | undefined;
      if (existing) {
        if (existing.payload_hash !== envelope.payloadHash) {
          throw new OmoCommandError(
            "duplicate_payload_mismatch",
            "dedup key already exists with a different payload " +
              `(clientMutationId=${input.clientMutationId})`
          );
        }
        this.#db.exec("COMMIT");
        return toReceipt(rowToRecord(existing));
      }
      this.#db
        .prepare(
          `INSERT INTO commands (
             command_id, dedup_key, principal_user, principal_device,
             scope_json, kind, payload_json, payload_hash, state,
             operation_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`
        )
        .run(
          envelope.commandId,
          dedupKey,
          principal.userId,
          principal.deviceId,
          canonicalJson(input.scope),
          input.kind,
          canonicalJson(input.payload),
          envelope.payloadHash,
          input.operationId ?? null,
          now,
          now
        );
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    const record = this.getByCommandId(input.commandId);
    if (!record) {
      throw new OmoCommandError(
        "internal",
        "command missing immediately after commit"
      );
    }
    // The receipt is issued strictly after the FULL-synchronous commit above.
    return toReceipt(record);
  }

  getByCommandId(commandId: string): CommandRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM commands WHERE command_id = ?")
      .get(commandId) as CommandRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getByOperationId(operationId: string): CommandRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM commands WHERE operation_id = ?")
      .get(operationId) as CommandRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  listByScope(scope: CommandScope): readonly CommandRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM commands WHERE scope_json = ? ORDER BY seq ASC")
      .all(canonicalJson(scope)) as unknown as CommandRow[];
    return rows.map(rowToRecord);
  }

  #transition(
    commandId: string,
    next: CommandState,
    patch?: { operationId?: string; result?: unknown; error?: unknown }
  ): CommandRecord {
    const row = this.#db
      .prepare("SELECT * FROM commands WHERE command_id = ?")
      .get(commandId) as CommandRow | undefined;
    if (!row) {
      throw new OmoCommandError("unknown_command", commandId);
    }
    const current = row.state;
    if (current === next) {
      return rowToRecord(row);
    }
    if (
      isTerminalCommandState(current) ||
      !TRANSITIONS[current].includes(next)
    ) {
      throw new OmoCommandError(
        "operation_mismatch",
        `invalid command state transition ${current} → ${next} for ${commandId}`
      );
    }
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `UPDATE commands
           SET state = ?, updated_at = ?,
               operation_id = COALESCE(?, operation_id),
               result_json = COALESCE(?, result_json),
               error_json = COALESCE(?, error_json)
         WHERE command_id = ?`
      )
      .run(
        next,
        now,
        patch?.operationId ?? null,
        patch?.result === undefined ? null : canonicalJson(patch.result),
        patch?.error === undefined ? null : canonicalJson(patch.error),
        commandId
      );
    const updated = this.getByCommandId(commandId);
    if (!updated) {
      throw new OmoCommandError("internal", "command lost during transition");
    }
    return updated;
  }

  /** Execution side durably admitted the command under its operation id. */
  markAdmitted(commandId: string, operationId: string): CommandRecord {
    return this.#transition(commandId, "admitted", { operationId });
  }

  markRunning(commandId: string): CommandRecord {
    return this.#transition(commandId, "running");
  }

  markWaiting(commandId: string): CommandRecord {
    return this.#transition(commandId, "waiting");
  }

  complete(commandId: string, result: unknown): CommandRecord {
    return this.#transition(commandId, "completed", { result });
  }

  fail(commandId: string, error: unknown): CommandRecord {
    return this.#transition(commandId, "failed", { error });
  }

  cancel(commandId: string): CommandRecord {
    return this.#transition(commandId, "cancelled");
  }

  /** Effective durability configuration, reported at startup (§5.8.6). */
  durabilityReport(): DurabilityReport {
    return readDurabilityReport(this.#db);
  }

  close(): void {
    this.#db.close();
  }
}
