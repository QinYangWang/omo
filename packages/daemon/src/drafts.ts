import type { DatabaseSync } from "node:sqlite";
import type { Principal } from "@omo/control-plane/inbox";

/**
 * Personal input drafts (plan §6.1): user-level, versioned, online-saved.
 * A draft is never an offline execution queue — it is text the user has not
 * sent. CAS by revision so two devices editing the same draft conflict
 * loudly instead of silently losing text (§6.6).
 */

export interface DraftRecord {
  readonly body: string;
  readonly revision: number;
  readonly sessionId: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly userId: string;
}

export type DraftPutResult =
  | { readonly ok: true; readonly record: DraftRecord }
  | {
      readonly ok: false;
      readonly code: "revision_mismatch";
      readonly record?: DraftRecord;
    };

const DRAFT_SCHEMA = `
CREATE TABLE IF NOT EXISTS drafts (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  body TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id)
);
`;

interface DraftRow {
  body: string;
  revision: number;
  session_id: string;
  updated_at: string;
  updated_by: string;
  user_id: string;
}

const rowToDraft = (row: DraftRow): DraftRecord => ({
  body: row.body,
  revision: row.revision,
  sessionId: row.session_id,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
  userId: row.user_id,
});

export class DraftStore {
  readonly #db: DatabaseSync;
  readonly #onChange?: (record: DraftRecord) => void;

  private constructor(
    db: DatabaseSync,
    onChange?: (record: DraftRecord) => void
  ) {
    this.#db = db;
    this.#onChange = onChange;
  }

  static attach(
    db: DatabaseSync,
    onChange?: (record: DraftRecord) => void
  ): DraftStore {
    db.exec(DRAFT_SCHEMA);
    return new DraftStore(db, onChange);
  }

  #emit(record: DraftRecord): void {
    try {
      this.#onChange?.(record);
    } catch {
      // Listener failures never affect storage.
    }
  }

  get(userId: string, sessionId: string): DraftRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM drafts WHERE user_id = ? AND session_id = ?")
      .get(userId, sessionId) as DraftRow | undefined;
    return row ? rowToDraft(row) : undefined;
  }

  /**
   * First-writer-wins CAS inside one IMMEDIATE transaction. Empty body keeps
   * the row (revision chain stays continuous across clear → retype).
   */
  put(
    principal: Principal,
    sessionId: string,
    body: string,
    expectedRevision?: number
  ): DraftPutResult {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(principal.userId, sessionId);
      if (
        expectedRevision !== undefined &&
        expectedRevision !== (current?.revision ?? 0)
      ) {
        this.#db.exec("COMMIT");
        return {
          code: "revision_mismatch",
          ok: false,
          record: current,
        };
      }
      const nextRevision = (current?.revision ?? 0) + 1;
      this.#db
        .prepare(
          `INSERT INTO drafts (user_id, session_id, body, revision, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, session_id) DO UPDATE SET
             body = excluded.body,
             revision = excluded.revision,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`
        )
        .run(
          principal.userId,
          sessionId,
          body,
          nextRevision,
          principal.deviceId,
          new Date().toISOString()
        );
      this.#db.exec("COMMIT");
      const record = this.get(principal.userId, sessionId);
      if (!record) {
        throw new Error("draft lost after commit");
      }
      this.#emit(record);
      return { ok: true, record };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  listByUser(userId: string): readonly DraftRecord[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM drafts WHERE user_id = ? ORDER BY updated_at DESC"
      )
      .all(userId) as unknown as DraftRow[];
    return rows.map(rowToDraft);
  }
}
