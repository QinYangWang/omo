import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Principal } from "@omo/control-plane/inbox";
import { OmoCommandError } from "@omo/protocol/errors";
import {
  asId,
  type DeviceId,
  newDeviceId,
  newServerId,
  newUserId,
  type ServerId,
  type UserId,
} from "@omo/protocol/ids";
import { OMO_PROTOCOL_VERSION } from "@omo/protocol/version";

/**
 * Daemon identity, single-writer lock and device credentials (plan §4.2,
 * §5.5, §10.1; ADR-001).
 *
 *  - `serverId` is the persistent logical identity of this data directory,
 *    never derived from a URL; it is created once and stored in the control
 *    database.
 *  - The single-writer lock is an OS-level ownership mechanism: a daemon
 *    starts as writer only when no other LIVE process holds `daemon.lock`.
 *    A stale lock (holder PID confirmed dead) is taken over; a live holder
 *    is never fenced by timeout (§5.5: 无法确认旧写者停止时，不强行启动第二个写者).
 *    Residual risk: PID reuse by an unrelated process can block startup until
 *    the lock is removed manually; it can never produce two writers, because
 *    the lock is only broken when the recorded PID is dead.
 *  - Devices pair with a short bootstrap code and receive an independent
 *    revocable credential; only the SHA-256 hash of the token is persisted.
 */

export interface DaemonIdentity {
  readonly createdAt: string;
  readonly protocolVersion: number;
  readonly serverId: ServerId;
  /** Single-user v1: one implicit local user owns all devices (§10.1). */
  readonly userId: UserId;
}

const META_SCHEMA = `
CREATE TABLE IF NOT EXISTS daemon_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DEVICES_SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
`;

export class DaemonIdentityStore {
  readonly #identity: DaemonIdentity;

  private constructor(identity: DaemonIdentity) {
    this.#identity = identity;
  }

  /** Read the persisted identity, or mint one on first boot. */
  static attach(db: DatabaseSync): DaemonIdentityStore {
    db.exec(META_SCHEMA);
    const read = (key: string): string | undefined => {
      const row = db
        .prepare("SELECT value FROM daemon_meta WHERE key = ?")
        .get(key) as { value: string } | undefined;
      return row?.value;
    };
    let serverId = read("server_id");
    let userId = read("user_id");
    let createdAt = read("created_at");
    if (!(serverId && userId && createdAt)) {
      serverId = newServerId();
      userId = newUserId();
      createdAt = new Date().toISOString();
      const insert = db.prepare(
        "INSERT INTO daemon_meta (key, value) VALUES (?, ?)"
      );
      insert.run("server_id", serverId);
      insert.run("user_id", userId);
      insert.run("created_at", createdAt);
    }
    return new DaemonIdentityStore({
      createdAt,
      protocolVersion: OMO_PROTOCOL_VERSION,
      serverId: asId<ServerId>(serverId),
      userId: asId<UserId>(userId),
    });
  }

  identity(): DaemonIdentity {
    return this.#identity;
  }
}

interface LockFileContent {
  readonly pid: number;
  readonly startedAt: string;
  readonly token: string;
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// fs open(2) flag combination; O_CREAT/O_EXCL/O_WRONLY are disjoint bits.
const OPEN_EXCLUSIVE =
  constants.O_CREAT + constants.O_EXCL + constants.O_WRONLY;

export class DaemonLock {
  readonly #path: string;
  readonly #token: string;
  #released = false;

  private constructor(path: string, token: string) {
    this.#path = path;
    this.#token = token;
  }

  static acquire(dataDir: string): DaemonLock {
    const path = join(dataDir, "daemon.lock");
    const token = randomBytes(16).toString("hex");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (existsSync(path)) {
        let content: LockFileContent | undefined;
        try {
          content = JSON.parse(readFileSync(path, "utf8")) as LockFileContent;
        } catch {
          // Corrupt lock file: the writer died mid-write; safe to replace.
          content = undefined;
        }
        if (content && pidAlive(content.pid)) {
          throw new OmoCommandError(
            "writer_conflict",
            `data directory ${dataDir} is owned by live daemon pid ${content.pid}; ` +
              "refusing to start a second writer (plan §5.5)"
          );
        }
        // Holder confirmed dead: take over the stale lock.
        rmSync(path, { force: true });
      }
      try {
        const fd = openSync(path, OPEN_EXCLUSIVE);
        try {
          const content: LockFileContent = {
            pid: process.pid,
            startedAt: new Date().toISOString(),
            token,
          };
          writeSync(fd, `${JSON.stringify(content)}\n`);
        } finally {
          closeSync(fd);
        }
        return new DaemonLock(path, token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        // Lost the creation race; loop once to re-read and decide.
      }
    }
    throw new OmoCommandError(
      "writer_conflict",
      `lost the lock creation race for ${dataDir}`
    );
  }

  /** Unique token of this lock holder; doubles as the supervisor instance token. */
  get token(): string {
    return this.#token;
  }

  /** Release only if this instance still owns the lock. */
  release(): void {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: mutated here
    if (this.#released) {
      return;
    }
    this.#released = true;
    try {
      const content = JSON.parse(
        readFileSync(this.#path, "utf8")
      ) as LockFileContent;
      if (content.token === this.#token) {
        rmSync(this.#path, { force: true });
      }
    } catch {
      // Lock already gone (e.g. stale takeover after our death): nothing to do.
    }
  }
}

export interface DeviceRecord {
  readonly createdAt: string;
  readonly deviceId: DeviceId;
  readonly name?: string;
  readonly revokedAt?: string;
  readonly userId: UserId;
}

interface DeviceRow {
  created_at: string;
  device_id: string;
  name: string | null;
  revoked_at: string | null;
  token_hash: string;
  user_id: string;
}

const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

const rowToDevice = (row: DeviceRow): DeviceRecord => ({
  createdAt: row.created_at,
  deviceId: asId<DeviceId>(row.device_id),
  name: row.name ?? undefined,
  revokedAt: row.revoked_at ?? undefined,
  userId: asId<UserId>(row.user_id),
});

export class DeviceStore {
  readonly #db: DatabaseSync;
  readonly #userId: UserId;

  private constructor(db: DatabaseSync, userId: UserId) {
    this.#db = db;
    this.#userId = userId;
  }

  static attach(db: DatabaseSync, identity: DaemonIdentity): DeviceStore {
    db.exec(DEVICES_SCHEMA);
    return new DeviceStore(db, identity.userId);
  }

  /**
   * Exchange the short bootstrap pairing code for a revocable device
   * credential (§10.1). The raw token is returned exactly once; only its
   * hash is stored.
   */
  pair(
    code: string,
    expectedCode: string,
    name?: string
  ): { readonly deviceId: DeviceId; readonly token: string } {
    if (code !== expectedCode) {
      throw new OmoCommandError("unauthenticated", "invalid pairing code");
    }
    const deviceId = newDeviceId();
    const token = `omod_${randomBytes(32).toString("hex")}`;
    this.#db
      .prepare(
        `INSERT INTO devices (device_id, user_id, name, token_hash, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)`
      )
      .run(
        deviceId,
        this.#userId,
        name ?? null,
        hashToken(token),
        new Date().toISOString()
      );
    return { deviceId, token };
  }

  /** Resolve a bearer token to its principal; revoked/unknown → undefined. */
  authenticate(token: string): Principal | undefined {
    const row = this.#db
      .prepare(
        "SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL"
      )
      .get(hashToken(token)) as DeviceRow | undefined;
    if (!row) {
      return undefined;
    }
    return { deviceId: row.device_id, userId: row.user_id };
  }

  /** Idempotent device revocation (§10.1: 设备可独立撤销). */
  revoke(deviceId: string): DeviceRecord {
    this.#db
      .prepare(
        "UPDATE devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL"
      )
      .run(new Date().toISOString(), deviceId);
    const row = this.#db
      .prepare("SELECT * FROM devices WHERE device_id = ?")
      .get(deviceId) as DeviceRow | undefined;
    if (!row) {
      throw new OmoCommandError(
        "unknown_command",
        `unknown device ${deviceId}`
      );
    }
    return rowToDevice(row);
  }

  /** List devices without token hashes. */
  list(): readonly DeviceRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM devices ORDER BY created_at ASC")
      .all() as unknown as DeviceRow[];
    return rows.map(rowToDevice);
  }
}

/** Load or mint the bootstrap pairing code for this data directory. */
export const loadPairingCode = (dataDir: string, explicit?: string): string => {
  if (explicit) {
    return explicit;
  }
  const fromEnv = process.env.OMO_DAEMON_PAIRING_CODE;
  if (fromEnv) {
    return fromEnv;
  }
  const path = join(dataDir, "pairing-code");
  if (existsSync(path)) {
    return readFileSync(path, "utf8").trim();
  }
  const code = randomBytes(6).toString("hex");
  const fd = openSync(path, OPEN_EXCLUSIVE, 0o600);
  try {
    writeSync(fd, `${code}\n`);
  } finally {
    closeSync(fd);
  }
  return code;
};
