import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { OmoCommandError } from "@omo/protocol/errors";
import { type ArtifactId, asId, newArtifactId } from "@omo/protocol/ids";
import { fsyncDirectory, sha256Hex } from "./files.ts";

/**
 * Content-addressed artifact store (plan §5.1, §5.3, §5.8.3; ADR-003).
 *
 * Layout: `<dataDir>/artifacts/objects/<sha256[:2]>/<sha256>` with a `tmp/`
 * staging area. Publication order is the §5.8.3 durability protocol:
 *   write temp → fsync(file) → atomic rename → fsync(dir) → commit the
 *   metadata row (FULL) → only then return the receipt.
 * A crash between rename and row commit leaves an ORPHAN object — collected
 * by `sweepOrphans()` at daemon start — but a committed row can never point
 * at a file that was not durably on disk first.
 *
 * Puts are idempotent by content: the same bytes return the original
 * artifact record, so retries after a lost response never duplicate
 * storage (§5.4 recovery semantics).
 */

export interface ArtifactRecord {
  readonly artifactId: ArtifactId;
  readonly createdAt: string;
  readonly mime?: string;
  readonly name?: string;
  readonly sha256: string;
  readonly size: number;
}

const ARTIFACT_SCHEMA = `
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  mime TEXT,
  name TEXT,
  created_at TEXT NOT NULL
);
`;

interface ArtifactRow {
  artifact_id: string;
  created_at: string;
  mime: string | null;
  name: string | null;
  sha256: string;
  size: number;
}

const rowToArtifact = (row: ArtifactRow): ArtifactRecord => ({
  artifactId: asId<ArtifactId>(row.artifact_id),
  createdAt: row.created_at,
  mime: row.mime ?? undefined,
  name: row.name ?? undefined,
  sha256: row.sha256,
  size: row.size,
});

export class ArtifactStore {
  readonly #db: DatabaseSync;
  readonly #objectsDir: string;
  readonly #rootDir: string;
  readonly #tmpDir: string;

  private constructor(db: DatabaseSync, rootDir: string) {
    this.#db = db;
    this.#rootDir = rootDir;
    this.#objectsDir = join(rootDir, "objects");
    this.#tmpDir = join(rootDir, "tmp");
  }

  static open(dataDir: string, db: DatabaseSync): ArtifactStore {
    const rootDir = join(dataDir, "artifacts");
    mkdirSync(join(rootDir, "objects"), { recursive: true });
    mkdirSync(join(rootDir, "tmp"), { recursive: true });
    db.exec(ARTIFACT_SCHEMA);
    return new ArtifactStore(db, rootDir);
  }

  /** Store root (diagnostics and tests). */
  get rootDir(): string {
    return this.#rootDir;
  }

  #objectPath(sha256: string): string {
    return join(this.#objectsDir, sha256.slice(0, 2), sha256);
  }

  #getByHash(sha256: string): ArtifactRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM artifacts WHERE sha256 = ?")
      .get(sha256) as ArtifactRow | undefined;
    return row ? rowToArtifact(row) : undefined;
  }

  /**
   * Publish bytes durably, then commit the metadata row. Idempotent by
   * content hash; self-heals a metadata row whose object file is missing
   * (the bytes are at hand, so the file is rewritten under the protocol).
   */
  put(
    bytes: Buffer,
    meta?: { readonly mime?: string; readonly name?: string }
  ): ArtifactRecord {
    const sha256 = sha256Hex(bytes);
    const existing = this.#getByHash(sha256);
    if (existing && existsSync(this.#objectPath(sha256))) {
      return existing;
    }

    const tmpPath = join(this.#tmpDir, randomUUID());
    const fd = openSync(tmpPath, "w");
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const objectPath = this.#objectPath(sha256);
    mkdirSync(join(this.#objectsDir, sha256.slice(0, 2)), {
      recursive: true,
    });
    // Same-content overwrite via rename is harmless (identical bytes).
    renameSync(tmpPath, objectPath);
    fsyncDirectory(join(this.#objectsDir, sha256.slice(0, 2)));

    if (existing) {
      return existing;
    }
    const artifactId = newArtifactId();
    try {
      this.#db
        .prepare(
          `INSERT INTO artifacts (artifact_id, sha256, size, mime, name, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          artifactId,
          sha256,
          bytes.length,
          meta?.mime ?? null,
          meta?.name ?? null,
          new Date().toISOString()
        );
    } catch (error) {
      // Lost a concurrent put of identical content: return the winner's row.
      const winner = this.#getByHash(sha256);
      if (winner) {
        return winner;
      }
      // biome-ignore lint/style/useErrorCause: OmoCommandError forwards `cause` to super
      throw new OmoCommandError(
        "internal",
        "artifact insert failed and no winner row exists",
        false,
        { cause: error }
      );
    }
    const record = this.get(artifactId);
    if (!record) {
      throw new OmoCommandError("internal", "artifact lost after insert");
    }
    return record;
  }

  get(artifactId: string): ArtifactRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM artifacts WHERE artifact_id = ?")
      .get(artifactId) as ArtifactRow | undefined;
    return row ? rowToArtifact(row) : undefined;
  }

  list(): readonly ArtifactRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM artifacts ORDER BY created_at ASC")
      .all() as unknown as ArtifactRow[];
    return rows.map(rowToArtifact);
  }

  /** Read an object and verify its content hash on every read. */
  readBytes(record: ArtifactRecord): Buffer {
    const path = this.#objectPath(record.sha256);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      // biome-ignore lint/style/useErrorCause: OmoCommandError forwards `cause` to super
      throw new OmoCommandError(
        "storage_unavailable",
        `artifact object missing on disk: ${record.sha256}`,
        true,
        { cause: error }
      );
    }
    if (sha256Hex(bytes) !== record.sha256) {
      throw new OmoCommandError(
        "storage_unavailable",
        `artifact object failed integrity check: ${record.sha256}`
      );
    }
    return bytes;
  }

  /**
   * Delete orphan objects (no metadata row) and stale temp files older than
   * the grace window. Runs at daemon start, when the single-writer lock
   * guarantees no other process can be mid-publish (§5.5).
   */
  sweepOrphans(graceMs = 300_000): { readonly removed: number } {
    const cutoff = Date.now() - graceMs;
    let removed = 0;
    for (const entry of readdirSync(this.#tmpDir)) {
      const path = join(this.#tmpDir, entry);
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path);
        removed += 1;
      }
    }
    for (const shard of readdirSync(this.#objectsDir)) {
      const shardDir = join(this.#objectsDir, shard);
      if (!statSync(shardDir).isDirectory()) {
        continue;
      }
      for (const objectName of readdirSync(shardDir)) {
        if (this.#getByHash(objectName)) {
          continue;
        }
        const path = join(shardDir, objectName);
        if (statSync(path).mtimeMs < cutoff) {
          unlinkSync(path);
          removed += 1;
        }
      }
    }
    return { removed };
  }
}
