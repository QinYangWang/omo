import type { DatabaseSync } from "node:sqlite";
import type { CommandScope } from "@omo/protocol/command";
import { OmoCommandError } from "@omo/protocol/errors";
import {
  type DurabilityReport,
  readDurabilityReport,
} from "@omo/storage/durability";
import { openDurableDatabase } from "@omo/storage/durable-database";

/**
 * Persistent Interaction store (plan §5.1, §7.6).
 *
 * An Interaction is a durable pending interaction (question / approval) owned
 * by the daemon, never by a client window:
 *  - the request is persisted BEFORE any realtime projection exists;
 *  - exactly one answer is accepted inside a single transaction that compares
 *    status + revision + principal eligibility (first writer wins);
 *  - client disconnect never cancels; after restart the pending record is
 *    rebuilt from this store, not from a stale Promise or dialog.
 */

export type InteractionStatus =
  | "pending"
  | "answered"
  | "cancelled"
  | "expired";

export interface InteractionRecord {
  readonly answer?: unknown;
  readonly answeredBy?: string;
  readonly createdAt: string;
  readonly deadline?: string;
  readonly eligiblePrincipals: readonly string[];
  readonly interactionId: string;
  readonly invocationId: string;
  readonly pluginGeneration?: string;
  readonly request: unknown;
  readonly revision: number;
  readonly schemaVersion: number;
  readonly scope: CommandScope;
  readonly status: InteractionStatus;
  readonly updatedAt: string;
}

export interface NewInteraction {
  readonly deadline?: string;
  readonly eligiblePrincipals: readonly string[];
  readonly interactionId: string;
  readonly invocationId: string;
  readonly pluginGeneration?: string;
  readonly request: unknown;
  readonly schemaVersion: number;
  readonly scope: CommandScope;
}

export type AnswerResult =
  | { readonly ok: true; readonly record: InteractionRecord }
  | {
      readonly ok: false;
      readonly code:
        | "already_answered"
        | "not_eligible"
        | "revision_mismatch"
        | "unknown_interaction"
        | "not_pending";
      readonly record?: InteractionRecord;
    };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS interactions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  interaction_id TEXT NOT NULL UNIQUE,
  invocation_id TEXT NOT NULL,
  plugin_generation TEXT,
  scope_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  eligible_json TEXT NOT NULL,
  deadline TEXT,
  answer_json TEXT,
  answered_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS interactions_status ON interactions(status, seq);
CREATE INDEX IF NOT EXISTS interactions_scope ON interactions(scope_json, seq);
`;

interface InteractionRow {
  answer_json: string | null;
  answered_by: string | null;
  created_at: string;
  deadline: string | null;
  eligible_json: string;
  interaction_id: string;
  invocation_id: string;
  plugin_generation: string | null;
  request_json: string;
  revision: number;
  schema_version: number;
  scope_json: string;
  seq: number;
  status: InteractionStatus;
  updated_at: string;
}

const rowToRecord = (row: InteractionRow): InteractionRecord => ({
  answer: row.answer_json === null ? undefined : JSON.parse(row.answer_json),
  answeredBy: row.answered_by ?? undefined,
  createdAt: row.created_at,
  deadline: row.deadline ?? undefined,
  eligiblePrincipals: JSON.parse(row.eligible_json),
  interactionId: row.interaction_id,
  invocationId: row.invocation_id,
  pluginGeneration: row.plugin_generation ?? undefined,
  request: JSON.parse(row.request_json),
  revision: row.revision,
  schemaVersion: row.schema_version,
  scope: JSON.parse(row.scope_json),
  status: row.status,
  updatedAt: row.updated_at,
});

export class InteractionStore {
  readonly #db: DatabaseSync;
  readonly #onChange?: (record: InteractionRecord) => void;
  readonly #owned: boolean;

  private constructor(
    db: DatabaseSync,
    owned: boolean,
    onChange?: (record: InteractionRecord) => void
  ) {
    this.#db = db;
    this.#owned = owned;
    this.#onChange = onChange;
  }

  static open(path: string): InteractionStore {
    const { db } = openDurableDatabase(path);
    db.exec(SCHEMA);
    return new InteractionStore(db, true);
  }

  /**
   * Attach to a shared durable connection owned by the daemon (§5.4).
   * `onChange` fires after every committed create/answer/cancel — the sync
   * layer's emission point for interaction facts (§7.6).
   */
  static attach(
    db: DatabaseSync,
    onChange?: (record: InteractionRecord) => void
  ): InteractionStore {
    db.exec(SCHEMA);
    return new InteractionStore(db, false, onChange);
  }

  /** Persist the request first; projections are rebuilt from this record. */
  create(input: NewInteraction): InteractionRecord {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO interactions (
           interaction_id, invocation_id, plugin_generation, scope_json,
           schema_version, request_json, status, revision, eligible_json,
           deadline, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?)`
      )
      .run(
        input.interactionId,
        input.invocationId,
        input.pluginGeneration ?? null,
        JSON.stringify(input.scope),
        input.schemaVersion,
        JSON.stringify(input.request),
        JSON.stringify(input.eligiblePrincipals),
        input.deadline ?? null,
        now,
        now
      );
    const record = this.get(input.interactionId);
    if (!record) {
      throw new OmoCommandError(
        "internal",
        "interaction missing immediately after insert"
      );
    }
    this.#onChange?.(record);
    return record;
  }

  get(interactionId: string): InteractionRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM interactions WHERE interaction_id = ?")
      .get(interactionId) as InteractionRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  listPending(scope?: CommandScope): readonly InteractionRecord[] {
    const rows = (scope
      ? this.#db
          .prepare(
            "SELECT * FROM interactions WHERE status = 'pending' AND scope_json = ? ORDER BY seq ASC"
          )
          .all(JSON.stringify(scope))
      : this.#db
          .prepare(
            "SELECT * FROM interactions WHERE status = 'pending' ORDER BY seq ASC"
          )
          .all()) as unknown as InteractionRow[];
    return rows.map(rowToRecord);
  }

  /**
   * First-writer-wins answer inside ONE transaction (plan §7.6): the status
   * comparison, eligibility check and answer write commit atomically on the
   * FULL-synchronous connection. Losers observe the completed state.
   */
  answer(
    interactionId: string,
    principal: string,
    answer: unknown,
    expectedRevision?: number
  ): AnswerResult {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db
        .prepare("SELECT * FROM interactions WHERE interaction_id = ?")
        .get(interactionId) as InteractionRow | undefined;
      if (!row) {
        this.#db.exec("COMMIT");
        return { code: "unknown_interaction", ok: false };
      }
      const record = rowToRecord(row);
      if (record.status !== "pending") {
        this.#db.exec("COMMIT");
        return {
          code:
            record.status === "answered" ? "already_answered" : "not_pending",
          ok: false,
          record,
        };
      }
      if (!record.eligiblePrincipals.includes(principal)) {
        this.#db.exec("COMMIT");
        return { code: "not_eligible", ok: false, record };
      }
      if (
        expectedRevision !== undefined &&
        expectedRevision !== record.revision
      ) {
        this.#db.exec("COMMIT");
        return { code: "revision_mismatch", ok: false, record };
      }
      const now = new Date().toISOString();
      this.#db
        .prepare(
          `UPDATE interactions
             SET status = 'answered', answer_json = ?, answered_by = ?,
                 revision = revision + 1, updated_at = ?
           WHERE interaction_id = ? AND status = 'pending'`
        )
        .run(JSON.stringify(answer), principal, now, interactionId);
      this.#db.exec("COMMIT");
      const updated = this.get(interactionId);
      if (updated?.status !== "answered") {
        throw new OmoCommandError(
          "internal",
          "interaction answer lost after commit"
        );
      }
      this.#onChange?.(updated);
      return { ok: true, record: updated };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  cancel(interactionId: string): InteractionRecord {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `UPDATE interactions
           SET status = 'cancelled', revision = revision + 1, updated_at = ?
         WHERE interaction_id = ? AND status = 'pending'`
      )
      .run(now, interactionId);
    const record = this.get(interactionId);
    if (!record) {
      throw new OmoCommandError("unknown_command", interactionId);
    }
    this.#onChange?.(record);
    return record;
  }

  durabilityReport(): DurabilityReport {
    return readDurabilityReport(this.#db);
  }

  close(): void {
    if (this.#owned) {
      this.#db.close();
    }
  }
}
