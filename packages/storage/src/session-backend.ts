import {
  createNodeSqliteFactory,
  type SqliteDatabase,
  type SqliteDatabaseFactory,
} from "@earendil-works/pi-session-backend-sqlite-node";
import { enforceDurability, enforceReadOnlyDurability } from "./durability.ts";

/**
 * Durability-enforcing factory for the upstream session backend (plan §3.4,
 * §5.8). The upstream `SqliteSessionRepo` enables WAL but leaves
 * `synchronous` at the driver default; this adapter enforces and verifies
 * WAL + FULL on every connection it hands to the backend.
 */
export const createDurableSqliteFactory = (): SqliteDatabaseFactory => {
  const inner = createNodeSqliteFactory();
  const wrap = async (
    open: () => Promise<SqliteDatabase>,
    path: string,
    readOnly: boolean
  ): Promise<SqliteDatabase> => {
    const db = await open();
    try {
      if (readOnly) {
        enforceReadOnlyDurability(db);
      } else {
        enforceDurability(db, path);
      }
    } catch (error) {
      db.close();
      throw error;
    }
    return db;
  };
  return {
    open: (path: string) => wrap(() => inner.open(path), path, false),
    openExisting: (path: string) =>
      wrap(() => inner.openExisting(path), path, false),
    openReadOnly: (path: string) =>
      wrap(() => inner.openReadOnly(path), path, true),
  };
};
