import { realpathSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { OmoCommandError } from "@omo/protocol/errors";
import { asId, newWorkspaceId, type WorkspaceId } from "@omo/protocol/ids";

/**
 * Workspace registry + path guard (plan §5.1, §10.2; ADR-001).
 *
 * A Workspace is the logical boundary of a directory tree and its execution
 * policy; the path itself is a daemon-local (execution-side) property and is
 * never treated as a client identity. Registration is fail-closed: a
 * directory becomes a workspace only if its canonical path sits inside one of
 * the configured roots (`--workspace-root` / `OMO_WORKSPACE_ROOTS`, defaulting
 * to the daemon's cwd exactly like v1 `server/workspace.cjs`).
 *
 * Path resolution follows the v1 guard contract, extended for new-file
 * creation (symlink TOCTOU): existing targets are canonicalized with
 * realpath; missing targets canonicalize the PARENT and re-join the
 * basename. Everything escaping the workspace root is rejected with
 * `permission_denied`.
 */

export interface WorkspaceRecord {
  readonly createdAt: string;
  readonly name?: string;
  /** Canonical (realpath-resolved) absolute path; daemon-local. */
  readonly path: string;
  readonly workspaceId: WorkspaceId;
}

const WORKSPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL
);
`;

const SESSION_CATALOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_catalog (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_catalog_workspace
  ON session_catalog(workspace_id, created_at);
`;

interface WorkspaceRow {
  created_at: string;
  name: string | null;
  path: string;
  workspace_id: string;
}

const rowToWorkspace = (row: WorkspaceRow): WorkspaceRecord => ({
  createdAt: row.created_at,
  name: row.name ?? undefined,
  path: row.path,
  workspaceId: asId<WorkspaceId>(row.workspace_id),
});

/** True when `target` equals or sits under `root` (both already absolute). */
export const isInside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === "" || !(rel.startsWith("..") || isAbsolute(rel));
};

const canonicalize = (path: string): string => {
  try {
    return realpathSync(path);
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: OmoCommandError forwards `cause` to super
    throw new OmoCommandError(
      "unknown_workspace",
      `path does not exist: ${path}`,
      false,
      { cause: error }
    );
  }
};

export class WorkspaceRegistry {
  readonly #db: DatabaseSync;
  readonly #onChange?: (record: WorkspaceRecord) => void;
  readonly #roots: readonly string[];

  private constructor(
    db: DatabaseSync,
    roots: readonly string[],
    onChange?: (record: WorkspaceRecord) => void
  ) {
    this.#db = db;
    this.#onChange = onChange;
    // Roots are canonicalized best-effort; a root that does not exist yet is
    // kept literal so it can never be escaped by accident.
    this.#roots = roots.map((root) => {
      try {
        return realpathSync(resolve(root));
      } catch {
        return resolve(root);
      }
    });
  }

  static attach(
    db: DatabaseSync,
    roots: readonly string[],
    onChange?: (record: WorkspaceRecord) => void
  ): WorkspaceRegistry {
    db.exec(WORKSPACE_SCHEMA);
    return new WorkspaceRegistry(db, roots, onChange);
  }

  #emit(record: WorkspaceRecord): void {
    try {
      this.#onChange?.(record);
    } catch {
      // Listener failures never affect storage.
    }
  }

  roots(): readonly string[] {
    return this.#roots;
  }

  /**
   * Register a directory as a workspace. Idempotent by canonical path: the
   * same directory registered twice returns the original record.
   */
  register(input: { name?: string; path: string }): WorkspaceRecord {
    if (!(input.path && input.path.length > 0)) {
      throw new OmoCommandError("unknown_schema", "workspace path is required");
    }
    const canonical = canonicalize(resolve(input.path));
    if (!statSync(canonical).isDirectory()) {
      throw new OmoCommandError(
        "unknown_workspace",
        `workspace path is not a directory: ${canonical}`
      );
    }
    if (!this.#roots.some((root) => isInside(root, canonical))) {
      throw new OmoCommandError(
        "permission_denied",
        `path ${canonical} is outside the configured workspace roots`
      );
    }
    const existing = this.#db
      .prepare("SELECT * FROM workspaces WHERE path = ?")
      .get(canonical) as WorkspaceRow | undefined;
    if (existing) {
      return rowToWorkspace(existing);
    }
    const workspaceId = newWorkspaceId();
    this.#db
      .prepare(
        `INSERT INTO workspaces (workspace_id, path, name, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        workspaceId,
        canonical,
        input.name ?? null,
        new Date().toISOString()
      );
    const record = this.get(workspaceId);
    if (!record) {
      throw new OmoCommandError("internal", "workspace lost after insert");
    }
    this.#emit(record);
    return record;
  }

  get(workspaceId: string): WorkspaceRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM workspaces WHERE workspace_id = ?")
      .get(workspaceId) as WorkspaceRow | undefined;
    return row ? rowToWorkspace(row) : undefined;
  }

  list(): readonly WorkspaceRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM workspaces ORDER BY created_at ASC")
      .all() as unknown as WorkspaceRow[];
    return rows.map(rowToWorkspace);
  }

  #requireWorkspace(workspaceId: string): WorkspaceRecord {
    const record = this.get(workspaceId);
    if (!record) {
      throw new OmoCommandError(
        "unknown_workspace",
        `unknown workspace ${workspaceId}`
      );
    }
    return record;
  }

  /** Resolve an EXISTING workspace-relative path, canonicalized and guarded. */
  resolveExisting(workspaceId: string, relativePath: string): string {
    const workspace = this.#requireWorkspace(workspaceId);
    if (!relativePath || relativePath.length === 0) {
      throw new OmoCommandError("unknown_schema", "path is required");
    }
    if (isAbsolute(relativePath)) {
      throw new OmoCommandError(
        "permission_denied",
        `absolute paths are not workspace-relative: ${relativePath}`
      );
    }
    // Lexical pre-check: reject obvious .. escapes even when the target is
    // missing, so "not found" never masks an escape attempt.
    const resolved = resolve(workspace.path, relativePath);
    if (!isInside(workspace.path, resolved)) {
      throw new OmoCommandError(
        "permission_denied",
        `path escapes the workspace: ${relativePath}`
      );
    }
    let canonical: string;
    try {
      canonical = realpathSync(resolved);
    } catch (error) {
      // biome-ignore lint/style/useErrorCause: OmoCommandError forwards `cause` to super
      throw new OmoCommandError(
        "unknown_command",
        `path does not exist in workspace: ${relativePath}`,
        false,
        { cause: error }
      );
    }
    if (!isInside(workspace.path, canonical)) {
      throw new OmoCommandError(
        "permission_denied",
        `path escapes the workspace: ${relativePath}`
      );
    }
    return canonical;
  }

  /**
   * Resolve a workspace-relative path for WRITING. The target may not exist
   * yet: the parent directory is canonicalized (closing the symlink window)
   * and the basename re-joined; an existing target is fully canonicalized so
   * a symlink pointing outside the workspace is rejected.
   */
  resolveForWrite(workspaceId: string, relativePath: string): string {
    const workspace = this.#requireWorkspace(workspaceId);
    if (!relativePath || relativePath.length === 0) {
      throw new OmoCommandError("unknown_schema", "path is required");
    }
    if (isAbsolute(relativePath)) {
      throw new OmoCommandError(
        "permission_denied",
        `absolute paths are not workspace-relative: ${relativePath}`
      );
    }
    const target = resolve(workspace.path, relativePath);
    let parentCanonical: string;
    try {
      parentCanonical = realpathSync(dirname(target));
    } catch (error) {
      // biome-ignore lint/style/useErrorCause: OmoCommandError forwards `cause` to super
      throw new OmoCommandError(
        "unknown_command",
        `parent directory does not exist for: ${relativePath}`,
        false,
        { cause: error }
      );
    }
    if (!isInside(workspace.path, parentCanonical)) {
      throw new OmoCommandError(
        "permission_denied",
        `parent directory escapes the workspace: ${relativePath}`
      );
    }
    const guarded = join(parentCanonical, basename(target));
    try {
      const existing = realpathSync(guarded);
      if (!isInside(workspace.path, existing)) {
        throw new OmoCommandError(
          "permission_denied",
          `path is a symlink escaping the workspace: ${relativePath}`
        );
      }
    } catch (error) {
      if (error instanceof OmoCommandError) {
        throw error;
      }
      // Target does not exist yet — that is the normal create path.
    }
    return guarded;
  }
}

export interface SessionCatalogEntry {
  readonly createdAt: string;
  readonly name?: string;
  readonly sessionId: string;
  readonly workspaceId: string;
}

interface CatalogRow {
  created_at: string;
  name: string | null;
  session_id: string;
  workspace_id: string;
}

const rowToEntry = (row: CatalogRow): SessionCatalogEntry => ({
  createdAt: row.created_at,
  name: row.name ?? undefined,
  sessionId: row.session_id,
  workspaceId: row.workspace_id,
});

/**
 * Product-side session catalog (plan §5.2/§5.7): binds every daemon-created
 * session to its workspace. This is a rebuildable projection for listing;
 * the execution facts stay in the runtime's per-session stores.
 */
export class SessionCatalog {
  readonly #db: DatabaseSync;
  readonly #onChange?: (record: SessionCatalogEntry) => void;

  private constructor(
    db: DatabaseSync,
    onChange?: (record: SessionCatalogEntry) => void
  ) {
    this.#db = db;
    this.#onChange = onChange;
  }

  static attach(
    db: DatabaseSync,
    onChange?: (record: SessionCatalogEntry) => void
  ): SessionCatalog {
    db.exec(SESSION_CATALOG_SCHEMA);
    return new SessionCatalog(db, onChange);
  }

  #emit(record: SessionCatalogEntry): void {
    try {
      this.#onChange?.(record);
    } catch {
      // Listener failures never affect storage.
    }
  }

  record(entry: {
    createdAt?: string;
    name?: string;
    sessionId: string;
    workspaceId: string;
  }): SessionCatalogEntry {
    this.#db
      .prepare(
        `INSERT INTO session_catalog (session_id, workspace_id, name, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO NOTHING`
      )
      .run(
        entry.sessionId,
        entry.workspaceId,
        entry.name ?? null,
        entry.createdAt ?? new Date().toISOString()
      );
    const record = this.get(entry.sessionId);
    if (!record) {
      throw new OmoCommandError("internal", "session catalog row lost");
    }
    this.#emit(record);
    return record;
  }

  get(sessionId: string): SessionCatalogEntry | undefined {
    const row = this.#db
      .prepare("SELECT * FROM session_catalog WHERE session_id = ?")
      .get(sessionId) as CatalogRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  listByWorkspace(workspaceId: string): readonly SessionCatalogEntry[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM session_catalog WHERE workspace_id = ? ORDER BY created_at ASC"
      )
      .all(workspaceId) as unknown as CatalogRow[];
    return rows.map(rowToEntry);
  }

  listAll(): readonly SessionCatalogEntry[] {
    const rows = this.#db
      .prepare("SELECT * FROM session_catalog ORDER BY created_at ASC")
      .all() as unknown as CatalogRow[];
    return rows.map(rowToEntry);
  }

  rename(sessionId: string, name: string): SessionCatalogEntry {
    const result = this.#db
      .prepare("UPDATE session_catalog SET name = ? WHERE session_id = ?")
      .run(name, sessionId);
    if (result.changes === 0) {
      throw new OmoCommandError(
        "unknown_command",
        `unknown session ${sessionId}`
      );
    }
    const record = this.get(sessionId);
    if (!record) {
      throw new OmoCommandError("internal", "session lost after rename");
    }
    this.#emit(record);
    return record;
  }
}
