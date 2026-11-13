// Typed access to the Go host functions installed by the embedded runtime.
declare const __host_log: (level: string, message: string) => void;
declare const __host_fs: (op: string, payload: string) => string;
declare const __host_sql: (payload: string) => string;
declare const __host_metric: (payload: string) => void;
declare const __host_agent: (payload: string) => void;

export type SqliteValue = null | number | bigint | string | Uint8Array;

const encodeValue = (value: SqliteValue) => {
  if (typeof value === "bigint") return { $i: value.toString() };
  if (value instanceof Uint8Array) return { $b: bytesToBase64(value) };
  return value;
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const decodeValue = (value: any) => {
  if (value && typeof value === "object" && typeof value.$b === "string") {
    const binary = atob(value.$b);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return value;
};

const callSql = (payload: Record<string, unknown>): any => {
  const text = __host_sql(JSON.stringify(payload));
  return text ? JSON.parse(text) : null;
};

export type HostExecutor = {
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: SqliteValue[]): Promise<void>;
  runCounted(sql: string, ...params: SqliteValue[]): Promise<number>;
  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined>;
  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]>;
};

const executor = (sql: string, op: string, params: SqliteValue[] = []): any => {
  const res = callSql({ op, sql, params: params.map(encodeValue) });
  return res;
};

const rowsOf = (res: any): any[] =>
  Array.isArray(res?.rows) ? res.rows.map((row: any) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, decodeValue(v)]))) : [];

const makeExecutor = (): HostExecutor => ({
  exec: async (sql) => {
    executor(sql, "exec");
  },
  run: async (sql, ...params) => {
    executor(sql, "run", params);
  },
  runCounted: async (sql, ...params) => {
    const res = executor(sql, "run", params);
    return Number(res?.changes ?? 0);
  },
  get: async (sql, ...params) => {
    const res = executor(sql, "get", params);
    return rowsOf(res)[0];
  },
  all: async (sql, ...params) => {
    const res = executor(sql, "all", params);
    return rowsOf(res);
  },
});

/**
 * SQLite database facade over the Go host's modernc.org/sqlite connection.
 *
 * Chord's storage contract requires unrelated work to wait while a
 * transaction runs. Host calls are synchronous, so the only way another
 * task can slip in is at an `await` inside the transaction callback; those
 * operations are queued until the transaction ends.
 */
export const createHostSqlite = () => {
  const ctx = makeExecutor();
  let inTransaction = false;
  const queued: Array<() => void> = [];

  const drain = () => {
    while (!inTransaction && queued.length > 0) queued.shift()!();
  };

  const outside = <T>(fn: () => Promise<T>): Promise<T> => {
    if (!inTransaction) return fn();
    return new Promise<T>((resolve, reject) => {
      queued.push(() => {
        fn().then(resolve, reject);
      });
    });
  };

  const db = {
    exec: (sql: string) => outside(() => ctx.exec(sql)),
    run: (sql: string, ...params: SqliteValue[]) => outside(() => ctx.run(sql, ...params)),
    runCounted: (sql: string, ...params: SqliteValue[]) => outside(() => ctx.runCounted(sql, ...params)),
    get: <T extends object>(sql: string, ...params: SqliteValue[]) => outside(() => ctx.get<T>(sql, ...params)),
    all: <T extends object>(sql: string, ...params: SqliteValue[]) => outside(() => ctx.all<T>(sql, ...params)),
    transaction: async <T>(callback: (tx: HostExecutor) => Promise<T>): Promise<T> => {
      if (inTransaction) throw new Error("nested transaction");
      inTransaction = true;
      try {
        ctx.exec("BEGIN IMMEDIATE");
        let value: T;
        try {
          value = await callback(makeExecutor());
        } catch (error) {
          ctx.exec("ROLLBACK");
          throw error;
        }
        ctx.exec("COMMIT");
        return value;
      } finally {
        inTransaction = false;
        drain();
      }
    },
    close: async () => {},
  };
  return db;
};

export const hostFs = (op: string, payload: Record<string, unknown>): any => {
  const text = __host_fs(op, JSON.stringify(payload));
  return text ? JSON.parse(text) : null;
};

export const hostLog = (level: string, message: string) => {
  try {
    __host_log(level, message);
  } catch {}
};

/** Persist one finished agent turn; the Go host stores it in the app database. */
export const hostRecordMetric = (metric: unknown) => {
  try {
    __host_metric(JSON.stringify(metric));
  } catch {}
};

/** Persist one agent node and the agents it depends on. */
export const hostRecordAgent = (agent: unknown) => {
  try {
    __host_agent(JSON.stringify(agent));
  } catch {}
};
