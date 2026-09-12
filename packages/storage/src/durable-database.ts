import { DatabaseSync } from "node:sqlite";
import {
  type DurabilityReport,
  enforceDurability,
  enforceReadOnlyDurability,
} from "./durability.ts";

/**
 * Open a control-plane SQLite database under the §5.8 durability baseline.
 * The returned handle is synchronous; callers must run it on a dedicated
 * runtime worker when the control plane must not block (plan §8.5.5).
 */
export const openDurableDatabase = (
  path: string,
  options?: { readonly readOnly?: boolean }
): { readonly db: DatabaseSync; readonly report: DurabilityReport } => {
  const db = new DatabaseSync(path, { readOnly: options?.readOnly === true });
  try {
    if (options?.readOnly === true) {
      enforceReadOnlyDurability(db);
      return {
        db,
        report: { journalMode: "wal", synchronous: 2, userVersion: 0 },
      };
    }
    const report = enforceDurability(db, path);
    return { db, report };
  } catch (error) {
    db.close();
    throw error;
  }
};
