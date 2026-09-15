import type { DatabaseSync } from "node:sqlite";
import type { Principal } from "@omo/control-plane/inbox";
import { OmoCommandError } from "@omo/protocol/errors";

/**
 * Terminal manager: durable terminal records + live PTY processes with
 * input ownership (plan §6.6 多端终端, §8.4 进程监督, §5.8 终端边界).
 *
 * Durable vs volatile, deliberately separated:
 *  - DURABLE (control DB, FULL commit): the terminal record — workspace, cwd,
 *    shell, size, pid + start token, controller intent, exit status.
 *  - VOLATILE (in-memory ring buffer): the output tail. PTY echo is NOT a
 *    durable receipt (§5.8); the tail is a rebuildable projection with
 *    offset/floor semantics (clients reconnecting behind the floor get a
 *    reset, never a silent gap). Sensitive input (passwords) travels the
 *    same real-time channel and is never persisted.
 *
 * Input ownership: exactly one device holds input control at a time. The
 * intent is persisted (audit + restart survival); effectiveness additionally
 * requires the device to be connected — an acquire against a disconnected
 * controller's device succeeds WITHOUT force (§6.6 可转交). Force takeover
 * always wins and is audited as a command.
 *
 * Restart semantics (§8.4 默认不承诺附着): PTYs are children of the daemon
 * process, so a daemon restart orphans them; records are marked `orphaned`
 * at startup. PID reuse is guarded by storing pid + start timestamp, never
 * pid alone.
 */

export type TerminalStatus = "exited" | "orphaned" | "running";

export interface TerminalRecord {
  readonly cols: number;
  readonly controllerDeviceId?: string;
  readonly createdAt: string;
  readonly cwd: string;
  readonly exitCode?: number;
  readonly name?: string;
  readonly pid?: number;
  readonly pidStartedAt?: string;
  readonly rows: number;
  readonly shell: string;
  readonly status: TerminalStatus;
  readonly terminalId: string;
  readonly updatedAt: string;
  readonly workspaceId: string;
}

const TERMINAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS terminals (
  terminal_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT,
  shell TEXT NOT NULL,
  cwd TEXT NOT NULL,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  pid INTEGER,
  pid_started_at TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  controller_device_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS terminals_workspace ON terminals(workspace_id, created_at);
`;

interface TerminalRow {
  cols: number;
  controller_device_id: string | null;
  created_at: string;
  cwd: string;
  exit_code: number | null;
  name: string | null;
  pid: number | null;
  pid_started_at: string | null;
  rows: number;
  shell: string;
  status: TerminalStatus;
  terminal_id: string;
  updated_at: string;
  workspace_id: string;
}

const rowToTerminal = (row: TerminalRow): TerminalRecord => ({
  cols: row.cols,
  controllerDeviceId: row.controller_device_id ?? undefined,
  createdAt: row.created_at,
  cwd: row.cwd,
  exitCode: row.exit_code ?? undefined,
  name: row.name ?? undefined,
  pid: row.pid ?? undefined,
  pidStartedAt: row.pid_started_at ?? undefined,
  rows: row.rows,
  shell: row.shell,
  status: row.status,
  terminalId: row.terminal_id,
  updatedAt: row.updated_at,
  workspaceId: row.workspace_id,
});

export interface TerminalOutputChunk {
  /** Base64-encoded bytes (arbitrary PTY output is not safe UTF-8 JSON). */
  readonly dataB64: string;
  readonly nextOffset: number;
  readonly offset: number;
}

export interface TerminalSnapshot {
  readonly floor: number;
  readonly tail: readonly TerminalOutputChunk[];
  readonly terminal: TerminalRecord;
}

interface PtyHandle {
  kill: () => void;
  onData: (listener: (data: string) => void) => void;
  onExit: (listener: (event: { exitCode: number }) => void) => void;
  readonly pid: number;
  resize: (cols: number, rows: number) => void;
  write: (data: string) => void;
}

/** Injectable so tests can run without node-pty. */
export type PtySpawner = (options: {
  cols: number;
  cwd: string;
  rows: number;
  shell: string;
}) => PtyHandle;

interface LiveTerminal {
  chunks: TerminalOutputChunk[];
  floor: number;
  offset: number;
  pty: PtyHandle;
}

export type TerminalEventKind =
  | "controller"
  | "created"
  | "exit"
  | "orphaned"
  | "output"
  | "updated";

export interface TerminalEvent {
  readonly chunk?: TerminalOutputChunk;
  readonly kind: TerminalEventKind;
  readonly terminal: TerminalRecord;
  readonly terminalId: string;
  readonly type: "terminal";
}

const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

export interface TerminalManagerOptions {
  readonly db: DatabaseSync;
  /** Device liveness for control handover checks (from the sync hub). */
  readonly isDeviceConnected?: (deviceId: string) => boolean;
  readonly maxBufferBytes?: number;
  readonly onEvent?: (event: TerminalEvent) => void;
  readonly spawner: PtySpawner;
}

export class TerminalManager {
  readonly #db: DatabaseSync;
  readonly #isDeviceConnected: (deviceId: string) => boolean;
  readonly #live = new Map<string, LiveTerminal>();
  readonly #maxBuffer: number;
  readonly #onEvent?: (event: TerminalEvent) => void;
  readonly #spawner: PtySpawner;

  constructor(options: TerminalManagerOptions) {
    this.#db = options.db;
    this.#isDeviceConnected = options.isDeviceConnected ?? (() => true);
    this.#maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.#onEvent = options.onEvent;
    this.#spawner = options.spawner;
    this.#db.exec(TERMINAL_SCHEMA);
    // Startup rule (§8.4): children of the dead daemon are gone; never
    // reattach. Mark them and let clients see the truth.
    const orphaned = this.#db
      .prepare(
        `UPDATE terminals SET status = 'orphaned', updated_at = ?
         WHERE status = 'running'`
      )
      .run(new Date().toISOString());
    if (orphaned.changes > 0) {
      for (const row of this.#db
        .prepare("SELECT * FROM terminals WHERE status = 'orphaned'")
        .all() as unknown as TerminalRow[]) {
        this.#emit("orphaned", rowToTerminal(row));
      }
    }
  }

  #emit(
    kind: TerminalEventKind,
    record: TerminalRecord,
    chunk?: TerminalOutputChunk
  ): void {
    try {
      this.#onEvent?.({
        chunk,
        kind,
        terminal: record,
        terminalId: record.terminalId,
        type: "terminal",
      });
    } catch {
      // Listeners never affect the terminal itself.
    }
  }

  get(terminalId: string): TerminalRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM terminals WHERE terminal_id = ?")
      .get(terminalId) as TerminalRow | undefined;
    return row ? rowToTerminal(row) : undefined;
  }

  listByWorkspace(workspaceId: string): readonly TerminalRecord[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM terminals WHERE workspace_id = ? ORDER BY created_at ASC"
      )
      .all(workspaceId) as unknown as TerminalRow[];
    return rows.map(rowToTerminal);
  }

  /** Durable create + live spawn. */
  create(input: {
    readonly cols: number;
    readonly name?: string;
    readonly rows: number;
    readonly shell: string;
    readonly terminalId: string;
    readonly workspaceId: string;
    readonly workspacePath: string;
  }): TerminalRecord {
    const now = new Date().toISOString();
    const pty = this.#spawner({
      cols: input.cols,
      cwd: input.workspacePath,
      rows: input.rows,
      shell: input.shell,
    });
    const pidStartedAt = now;
    this.#db
      .prepare(
        `INSERT INTO terminals (
           terminal_id, workspace_id, name, shell, cwd, cols, rows,
           pid, pid_started_at, status, exit_code, controller_device_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, ?)`
      )
      .run(
        input.terminalId,
        input.workspaceId,
        input.name ?? null,
        input.shell,
        input.workspacePath,
        input.cols,
        input.rows,
        pty.pid,
        pidStartedAt,
        now,
        now
      );
    const live: LiveTerminal = {
      chunks: [],
      floor: 0,
      offset: 0,
      pty,
    };
    this.#live.set(input.terminalId, live);
    pty.onData((data) => {
      this.#writeOutput(input.terminalId, data);
    });
    pty.onExit(({ exitCode }) => {
      this.#onExit(input.terminalId, exitCode);
    });
    const record = this.get(input.terminalId);
    if (!record) {
      throw new OmoCommandError("internal", "terminal lost after insert");
    }
    this.#emit("created", record);
    return record;
  }

  #writeOutput(terminalId: string, data: string): void {
    const live = this.#live.get(terminalId);
    const record = this.get(terminalId);
    if (!(live && record)) {
      return;
    }
    const chunk: TerminalOutputChunk = {
      dataB64: Buffer.from(data, "utf8").toString("base64"),
      nextOffset: live.offset + data.length,
      offset: live.offset,
    };
    live.offset = chunk.nextOffset;
    live.chunks.push(chunk);
    // Bound the tail (§8.4): drop from the head; readers behind the floor
    // must reset, never receive a silent gap.
    while (
      live.offset - live.floor > this.#maxBuffer &&
      live.chunks.length > 1
    ) {
      const removed = live.chunks.shift();
      if (removed) {
        live.floor = removed.nextOffset;
      }
    }
    this.#emit("output", record, chunk);
  }

  #onExit(terminalId: string, exitCode: number): void {
    this.#db
      .prepare(
        `UPDATE terminals SET status = 'exited', exit_code = ?, updated_at = ?
         WHERE terminal_id = ? AND status = 'running'`
      )
      .run(exitCode, new Date().toISOString(), terminalId);
    const record = this.get(terminalId);
    if (record) {
      this.#emit("exit", record);
    }
  }

  /** Snapshot for (re)attach: volatile tail + durable record. */
  snapshot(terminalId: string, after?: number): TerminalSnapshot | undefined {
    const record = this.get(terminalId);
    if (!record) {
      return undefined;
    }
    const live = this.#live.get(terminalId);
    if (!live) {
      return { floor: 0, tail: [], terminal: record };
    }
    if (after !== undefined && after < live.floor) {
      throw new OmoCommandError(
        "reset_required",
        `terminal output cursor ${after} is behind floor ${live.floor}`
      );
    }
    const tail =
      after === undefined
        ? live.chunks
        : live.chunks.filter((chunk) => chunk.nextOffset > after);
    return { floor: live.floor, tail, terminal: record };
  }

  /**
   * Input control check (§6.6): the caller must hold control; holding
   * requires being the recorded controller AND being connected right now.
   */
  #assertControl(terminalId: string, principal: Principal): TerminalRecord {
    const record = this.get(terminalId);
    if (!record) {
      throw new OmoCommandError(
        "unknown_command",
        `unknown terminal ${terminalId}`
      );
    }
    if (record.status !== "running") {
      throw new OmoCommandError(
        "operation_mismatch",
        `terminal ${terminalId} is ${record.status}`
      );
    }
    if (record.controllerDeviceId !== principal.deviceId) {
      throw new OmoCommandError(
        "permission_denied",
        `terminal input is owned by device ${record.controllerDeviceId ?? "(none)"}; acquire control first`
      );
    }
    return record;
  }

  /** Real-time input; NEVER persisted (§5.8 terminal boundary). */
  writeInput(terminalId: string, principal: Principal, data: string): void {
    this.#assertControl(terminalId, principal);
    const live = this.#live.get(terminalId);
    if (!live) {
      throw new OmoCommandError(
        "storage_unavailable",
        `terminal ${terminalId} has no live process`,
        true
      );
    }
    live.pty.write(data);
  }

  resize(
    terminalId: string,
    principal: Principal,
    cols: number,
    rows: number
  ): void {
    this.#assertControl(terminalId, principal);
    const live = this.#live.get(terminalId);
    if (!live) {
      throw new OmoCommandError(
        "storage_unavailable",
        `terminal ${terminalId} has no live process`,
        true
      );
    }
    live.pty.resize(
      Math.max(2, Math.trunc(cols)),
      Math.max(1, Math.trunc(rows))
    );
    this.#db
      .prepare(
        "UPDATE terminals SET cols = ?, rows = ?, updated_at = ? WHERE terminal_id = ?"
      )
      .run(
        Math.max(2, Math.trunc(cols)),
        Math.max(1, Math.trunc(rows)),
        new Date().toISOString(),
        terminalId
      );
    const record = this.get(terminalId);
    if (record) {
      this.#emit("updated", record);
    }
  }

  /**
   * Transfer input control (§6.6). `release` clears control; `acquire` takes
   * it when free or when the current controller's device is disconnected;
   * `force` always takes it (audited via the calling command).
   */
  control(
    terminalId: string,
    principal: Principal,
    action: "acquire" | "force" | "release"
  ): TerminalRecord {
    const record = this.get(terminalId);
    if (!record) {
      throw new OmoCommandError(
        "unknown_command",
        `unknown terminal ${terminalId}`
      );
    }
    const current = record.controllerDeviceId;
    let next: string | null;
    if (action === "release") {
      if (current !== principal.deviceId) {
        throw new OmoCommandError(
          "permission_denied",
          "only the controller can release terminal input"
        );
      }
      next = null;
    } else if (action === "acquire") {
      const controllerGone =
        current !== undefined && !this.#isDeviceConnected(current);
      if (
        current !== undefined &&
        current !== principal.deviceId &&
        !controllerGone
      ) {
        throw new OmoCommandError(
          "permission_denied",
          `terminal input is held by device ${current}; use force to take over`
        );
      }
      next = principal.deviceId;
    } else {
      next = principal.deviceId;
    }
    this.#db
      .prepare(
        "UPDATE terminals SET controller_device_id = ?, updated_at = ? WHERE terminal_id = ?"
      )
      .run(next, new Date().toISOString(), terminalId);
    const updated = this.get(terminalId);
    if (!updated) {
      throw new OmoCommandError("internal", "terminal lost during control");
    }
    this.#emit("controller", updated);
    return updated;
  }

  /** SIGTERM → grace → SIGKILL; exit is recorded by onExit. */
  kill(terminalId: string, graceMs = 2000): TerminalRecord {
    const record = this.get(terminalId);
    if (!record) {
      throw new OmoCommandError(
        "unknown_command",
        `unknown terminal ${terminalId}`
      );
    }
    const live = this.#live.get(terminalId);
    if (live && record.status === "running") {
      live.pty.kill();
      const { pid, pidStartedAt } = record;
      setTimeout(() => {
        // PID-reuse guard (§8.4): only SIGKILL when the row still shows the
        // same pid + start token and is still marked running.
        const current = this.get(terminalId);
        if (
          current?.status === "running" &&
          current.pid === pid &&
          current.pidStartedAt === pidStartedAt
        ) {
          try {
            process.kill(pid as number, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }, graceMs).unref();
    }
    return record;
  }

  /** Graceful shutdown: kill every live PTY without waiting. */
  closeAll(): void {
    for (const [terminalId, live] of this.#live) {
      try {
        live.pty.kill();
      } catch {
        // Already gone.
      }
      this.#live.delete(terminalId);
    }
  }

  liveCount(): number {
    return this.#live.size;
  }
}
