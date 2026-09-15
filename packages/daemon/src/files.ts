import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { OmoCommandError } from "@omo/protocol/errors";
import type { WorkspaceRegistry } from "./workspaces.ts";

/**
 * Durable file save with CAS + crash reconciliation (plan §5.8.3/§5.8.4).
 *
 * Write protocol for every confirmed save:
 *   temp file in the same directory → fsync(file) → atomic rename →
 *   fsync(parent dir) → only then the command receipt commits.
 * A crash between the rename and the receipt is reconciled from the ACTUAL
 * file content: target hash means already applied, base hash means not
 * applied (re-apply), anything else is a conflict — the save and the receipt
 * are never presented as one transaction (§5.8.4).
 *
 * After the rename the target is re-read and its hash verified against the
 * goal, so a lost race against a concurrent writer fails loudly with
 * `revision_mismatch` instead of silently confirming someone else's bytes.
 */

export const sha256Hex = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/** fsync a directory (best effort on platforms that support it; §5.8.5). */
export const fsyncDirectory = (dir: string): void => {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Some platforms (notably Windows) do not fsync directories; the file
    // fsync + atomic rename still happened. Tracked by the §5.8.5 matrix.
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
};

/** Temp-write + fsync + atomic rename + dir fsync. Returns the hash. */
export const durableWriteFile = (
  absolutePath: string,
  bytes: Buffer
): { readonly hash: string; readonly size: number } => {
  const dir = dirname(absolutePath);
  const tmp = join(dir, `.omo-save-${randomUUID()}`);
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, absolutePath);
  fsyncDirectory(dir);
  return { hash: sha256Hex(bytes), size: bytes.length };
};

export interface FileContent {
  readonly bytes: Buffer;
  readonly hash: string;
  readonly size: number;
}

/** Read + hash a file the guard has already resolved. */
export const readFileContent = (absolutePath: string): FileContent => {
  const bytes = readFileSync(absolutePath);
  return { bytes, hash: sha256Hex(bytes), size: bytes.length };
};

export const tryReadFileContent = (
  absolutePath: string
): FileContent | undefined => {
  try {
    return readFileContent(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

export interface FileReadResult {
  readonly contentBase64: string;
  readonly hash: string;
  readonly path: string;
  readonly size: number;
  readonly truncated: boolean;
}

/** Guarded read for the HTTP surface, with an explicit byte cap. */
export const readWorkspaceFile = (
  registry: WorkspaceRegistry,
  workspaceId: string,
  relativePath: string,
  maxBytes: number
): FileReadResult => {
  const absolute = registry.resolveExisting(workspaceId, relativePath);
  if (!statSync(absolute).isFile()) {
    throw new OmoCommandError(
      "unknown_command",
      `not a regular file: ${relativePath}`
    );
  }
  const content = readFileContent(absolute);
  const truncated = content.size > maxBytes;
  const bytes = truncated ? content.bytes.subarray(0, maxBytes) : content.bytes;
  return {
    contentBase64: bytes.toString("base64"),
    hash: content.hash,
    path: relativePath,
    size: content.size,
    truncated,
  };
};

export interface FileSavePayload {
  readonly baseHash?: string;
  readonly contentBase64?: string;
  readonly contentText?: string;
  readonly path: string;
}

export type FileSaveOutcome =
  | {
      readonly created: boolean;
      readonly hash: string;
      readonly kind: "applied";
      readonly size: number;
    }
  | { readonly hash: string; readonly kind: "noop"; readonly size: number };

export type FileSaveFailure =
  | {
      readonly code: "revision_mismatch";
      readonly currentHash?: string;
      readonly message: string;
    }
  | {
      readonly code: "permission_denied" | "unknown_schema";
      readonly message: string;
    };

/**
 * Execute one file.save against the CURRENT file state. The same function
 * serves live execution and post-crash reconciliation, because every branch
 * is decided from durable content (§5.8.4).
 */
export const executeFileSave = (
  registry: WorkspaceRegistry,
  workspaceId: string,
  payload: FileSavePayload
): FileSaveOutcome => {
  const hasText = payload.contentText !== undefined;
  const hasBase64 = payload.contentBase64 !== undefined;
  if (hasText === hasBase64) {
    throw new OmoCommandError(
      "unknown_schema",
      "file.save requires exactly one of contentText / contentBase64"
    );
  }
  const bytes = hasText
    ? Buffer.from(payload.contentText as string, "utf8")
    : Buffer.from(payload.contentBase64 as string, "base64");
  const targetHash = sha256Hex(bytes);
  const absolute = registry.resolveForWrite(workspaceId, payload.path);
  const current = tryReadFileContent(absolute);

  if (current) {
    if (current.hash === targetHash) {
      // Already at the goal: a fresh submit with identical content, or a
      // crash between the rename and the receipt (§5.8.4 恢复对账).
      return {
        hash: targetHash,
        kind: "noop",
        size: current.size,
      };
    }
    if (payload.baseHash === undefined) {
      throw new OmoCommandError(
        "revision_mismatch",
        "saving an existing file requires baseHash",
        false
      );
    }
    if (current.hash !== payload.baseHash) {
      throw new OmoCommandError(
        "revision_mismatch",
        `file changed underneath: expected base ${payload.baseHash}, found ${current.hash}`
      );
    }
  } else if (payload.baseHash !== undefined) {
    throw new OmoCommandError(
      "revision_mismatch",
      `file is missing but a baseHash was supplied: ${payload.path}`
    );
  }

  const written = durableWriteFile(absolute, bytes);
  const verify = tryReadFileContent(absolute);
  if (!verify || verify.hash !== written.hash) {
    // Someone else won the race between our rename and this re-read.
    throw new OmoCommandError(
      "revision_mismatch",
      `post-write verification failed for ${payload.path} (concurrent writer)`
    );
  }
  return {
    created: !current,
    hash: written.hash,
    kind: "applied",
    size: written.size,
  };
};
