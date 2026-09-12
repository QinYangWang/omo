/**
 * omo durability baseline for every SQLite write connection (plan §5.8).
 *
 *  - WAL journal + `synchronous = FULL` (+ `fullfsync` on macOS)
 *  - pragmas are set on open AND read back; mismatch fails loudly
 *  - no write path may silently degrade to NORMAL or an in-memory queue
 *
 * The helpers are intentionally generic over a minimal queryable interface so
 * the same enforcement covers `node:sqlite` handles (control plane) and the
 * upstream `SqliteDatabase` wrapper (execution storage).
 */

export interface PragmaQueryable {
  readonly exec: (sql: string) => void;
  readonly prepare: (sql: string) => {
    readonly get: (...params: never[]) => unknown;
  };
}

export class DurabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurabilityError";
  }
}

export interface DurabilityReport {
  readonly fullfsync?: number;
  readonly journalMode: string;
  /** SQLite synchronous level; FULL is 2. */
  readonly synchronous: number;
  readonly userVersion: number;
}

const IS_DARWIN = process.platform === "darwin";

export const SYNCHRONOUS_FULL = 2;

/** Pragmas applied to every writable omo SQLite connection at open time. */
export const DURABILITY_PRAGMAS: readonly string[] = [
  "PRAGMA journal_mode = WAL;",
  "PRAGMA synchronous = FULL;",
  "PRAGMA busy_timeout = 5000;",
  ...(IS_DARWIN
    ? ["PRAGMA fullfsync = 1;", "PRAGMA checkpoint_fullfsync = 1;"]
    : []),
];

const readPragma = (
  db: PragmaQueryable,
  name: string
): number | string | undefined => {
  const row = db.prepare(`PRAGMA ${name}`).get() as
    | Record<string, number | string>
    | undefined
    | null;
  if (!row) {
    return undefined;
  }
  return row[name];
};

export const readDurabilityReport = (
  db: PragmaQueryable
): DurabilityReport => ({
  fullfsync: IS_DARWIN
    ? (readPragma(db, "fullfsync") as number | undefined)
    : undefined,
  journalMode: String(readPragma(db, "journal_mode") ?? ""),
  synchronous: Number(readPragma(db, "synchronous") ?? -1),
  userVersion: Number(readPragma(db, "user_version") ?? 0),
});

export const assertDurable = (
  db: PragmaQueryable,
  path: string
): DurabilityReport => {
  const report = readDurabilityReport(db);
  if (report.journalMode.toLowerCase() !== "wal") {
    throw new DurabilityError(
      `database ${path} did not enter WAL mode (got "${report.journalMode}"); ` +
        "refusing to accept writes without the §5.8 durability baseline"
    );
  }
  if (report.synchronous !== SYNCHRONOUS_FULL) {
    throw new DurabilityError(
      `database ${path} did not honour synchronous=FULL (got ${report.synchronous}); ` +
        "refusing to confirm receipts on a weaker durability setting"
    );
  }
  return report;
};

/** Apply and verify the full baseline on a writable connection. */
export const enforceDurability = (
  db: PragmaQueryable,
  path: string
): DurabilityReport => {
  for (const pragma of DURABILITY_PRAGMAS) {
    db.exec(pragma);
  }
  return assertDurable(db, path);
};

/** Read-only connections cannot switch journal mode; keep them non-blocking. */
export const enforceReadOnlyDurability = (db: PragmaQueryable): void => {
  db.exec("PRAGMA busy_timeout = 5000;");
};
