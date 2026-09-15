import type { DatabaseSync } from "node:sqlite";
import type {
  AgentRuntime,
  AgentRuntimeSession,
  RuntimeLaneEvent,
  RuntimeLaneSnapshot,
} from "@omo/agent-runtime/runtime";
import { OmoCommandError } from "@omo/protocol/errors";

/**
 * Session Worker ownership supervisor (plan §5.5; ADR-001/006).
 *
 * P1 keeps Session Workers in-process (the modular single control plane of
 * §4.1); the capacity baseline of one OS process per active root Session is
 * an ADR-006 / P4 concern and does not change this ownership contract:
 *
 *  - Every session has at most one open `AgentRuntimeSession` in this daemon.
 *  - Ownership is claimed in a single SQLite statement that monotonically
 *    increments `owner_epoch`; the epoch is recorded so that write boundaries
 *    can reject stale owners once workers move to separate processes (the
 *    upstream session backend provides no lease/fencing, plan §3.4).
 *  - On daemon restart the lock (identity.ts) guarantees the previous owner
 *    is dead; rows still marked owned are re-claimed lazily on first acquire
 *    with a bumped epoch, following §5.5's recovery order.
 *  - The pool is bounded (`maxWorkers`); beyond it, acquisition fails with a
 *    retryable `quota_exceeded` instead of silently queueing unbounded
 *    sessions (§8.3).
 */

const OWNERSHIP_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_owners (
  session_id TEXT PRIMARY KEY,
  owner_epoch INTEGER NOT NULL,
  owner_token TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  released_at TEXT
);
`;

export interface SessionWorkerSlot {
  readonly ownerEpoch: number;
  readonly session: AgentRuntimeSession;
  readonly sessionId: string;
}

interface OwnershipRow {
  acquired_at: string;
  owner_epoch: number;
  owner_token: string;
  released_at: string | null;
  session_id: string;
}

export interface SessionSupervisorOptions {
  /** Bound on awaiting a worker's serialized chain during release. */
  readonly closeGraceMs?: number;
  readonly db: DatabaseSync;
  /** Unique token of this daemon process instance. */
  readonly instanceToken: string;
  /** Maximum simultaneously open sessions (default 64). */
  readonly maxWorkers?: number;
  /** Lane watch events for the sync layer (§6.2 live tail). */
  readonly onLaneEvent?: (
    sessionId: string,
    event: RuntimeLaneEvent,
    snapshot: RuntimeLaneSnapshot
  ) => void;
  readonly runtime: AgentRuntime;
}

export class SessionSupervisor {
  readonly #db: DatabaseSync;
  readonly #closeGraceMs: number;
  readonly #instanceToken: string;
  readonly #maxWorkers: number;
  readonly #onLaneEvent?: (
    sessionId: string,
    event: RuntimeLaneEvent,
    snapshot: RuntimeLaneSnapshot
  ) => void;
  readonly #runtime: AgentRuntime;
  readonly #slots = new Map<
    string,
    {
      lastSnapshot?: RuntimeLaneSnapshot;
      readonly slot: SessionWorkerSlot;
      tail: Promise<unknown>;
      unwatch?: () => void;
    }
  >();

  constructor(options: SessionSupervisorOptions) {
    this.#db = options.db;
    this.#instanceToken = options.instanceToken;
    this.#closeGraceMs = options.closeGraceMs ?? 5000;
    this.#maxWorkers = options.maxWorkers ?? 64;
    this.#onLaneEvent = options.onLaneEvent;
    this.#runtime = options.runtime;
    this.#db.exec(OWNERSHIP_SCHEMA);
  }

  /**
   * Claim ownership in one atomic statement. Because the daemon holds the
   * data-directory lock, no other process can race this; within the process
   * the in-memory slot map is the single-writer guard.
   */
  #claim(sessionId: string): number {
    const now = new Date().toISOString();
    const row = this.#db
      .prepare(
        `INSERT INTO session_owners
           (session_id, owner_epoch, owner_token, acquired_at, released_at)
         VALUES (?, 1, ?, ?, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
           owner_epoch = session_owners.owner_epoch + 1,
           owner_token = excluded.owner_token,
           acquired_at = excluded.acquired_at,
           released_at = NULL
         RETURNING owner_epoch`
      )
      .get(sessionId, this.#instanceToken, now) as
      | Pick<OwnershipRow, "owner_epoch">
      | undefined;
    if (!row) {
      throw new OmoCommandError(
        "internal",
        `ownership claim returned no epoch for ${sessionId}`
      );
    }
    return row.owner_epoch;
  }

  /** Open (or return) the single writer slot for a session. */
  async acquire(sessionId: string): Promise<SessionWorkerSlot> {
    const existing = this.#slots.get(sessionId);
    if (existing) {
      return existing.slot;
    }
    if (this.#slots.size >= this.#maxWorkers) {
      throw new OmoCommandError(
        "quota_exceeded",
        `session worker limit reached (${this.#maxWorkers})`,
        true
      );
    }
    const ownerEpoch = this.#claim(sessionId);
    let session: AgentRuntimeSession;
    try {
      session = await this.#runtime.openSession(sessionId);
    } catch (error) {
      // biome-ignore lint/style/useErrorCause: OmoCommandError forwards `cause` to super
      throw new OmoCommandError(
        "unknown_command",
        `cannot open session ${sessionId}: ${(error as Error).message}`,
        false,
        { cause: error }
      );
    }
    const slot: SessionWorkerSlot = { ownerEpoch, session, sessionId };
    this.#slots.set(sessionId, { slot, tail: Promise.resolve() });
    this.#watchLane(sessionId);
    return slot;
  }

  /** Create a new session and claim its first ownership epoch. */
  async create(name?: string): Promise<SessionWorkerSlot> {
    if (this.#slots.size >= this.#maxWorkers) {
      throw new OmoCommandError(
        "quota_exceeded",
        `session worker limit reached (${this.#maxWorkers})`,
        true
      );
    }
    const session = await this.#runtime.createSession(name);
    const ownerEpoch = this.#claim(session.sessionId);
    const slot: SessionWorkerSlot = {
      ownerEpoch,
      session,
      sessionId: session.sessionId,
    };
    this.#slots.set(session.sessionId, { slot, tail: Promise.resolve() });
    this.#watchLane(session.sessionId);
    return slot;
  }

  get(sessionId: string): SessionWorkerSlot | undefined {
    return this.#slots.get(sessionId)?.slot;
  }

  /** Last observed lane snapshot for an open session, if any. */
  laneSnapshot(sessionId: string): RuntimeLaneSnapshot | undefined {
    return this.#slots.get(sessionId)?.lastSnapshot;
  }

  /** Attach the lane watcher used for live sync frames (fire-and-forget). */
  #watchLane(sessionId: string): void {
    const entry = this.#slots.get(sessionId);
    if (!(entry && this.#onLaneEvent)) {
      return;
    }
    entry.slot.session
      .watchLane((event, snapshot) => {
        const current = this.#slots.get(sessionId);
        if (!current) {
          return;
        }
        current.lastSnapshot = snapshot;
        this.#onLaneEvent?.(sessionId, event, snapshot);
      })
      .then((handle) => {
        const current = this.#slots.get(sessionId);
        if (current) {
          current.unwatch = handle.unsubscribe;
          current.lastSnapshot = handle.snapshot;
        } else {
          handle.unsubscribe();
        }
      })
      .catch(() => undefined);
  }

  workerCount(): number {
    return this.#slots.size;
  }

  /** Serialize all execution touching one session's lane (§5.4/§6.6). */
  runSerialized<T>(slot: SessionWorkerSlot, fn: () => Promise<T>): Promise<T> {
    const entry = this.#slots.get(slot.sessionId);
    if (!entry) {
      return Promise.reject(
        new OmoCommandError(
          "writer_conflict",
          `session ${slot.sessionId} is not owned by this daemon`
        )
      );
    }
    const result = entry.tail.then(fn);
    entry.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** Release one worker: close the runtime session and free the slot. */
  async release(sessionId: string): Promise<void> {
    const entry = this.#slots.get(sessionId);
    if (!entry) {
      return;
    }
    this.#slots.delete(sessionId);
    entry.unwatch?.();
    this.#db
      .prepare(
        `UPDATE session_owners SET released_at = ?
         WHERE session_id = ? AND owner_token = ?`
      )
      .run(new Date().toISOString(), sessionId, this.#instanceToken);
    // A crashed/hung drive must not block shutdown forever; the command
    // stays non-terminal and is reconciled by the next daemon start (§5.5).
    await Promise.race([
      entry.tail.catch(() => undefined),
      new Promise((resolve) => {
        setTimeout(resolve, this.#closeGraceMs);
      }),
    ]);
    await entry.slot.session.close();
  }

  /** Graceful shutdown: close every owned session writer. */
  async closeAll(): Promise<void> {
    const sessionIds = [...this.#slots.keys()];
    // Writers close sequentially: overlapping closes would interleave their
    // ownership bookkeeping on the same control connection.
    for (const sessionId of sessionIds) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential by design
      await this.release(sessionId);
    }
  }
}
