// Framework-agnostic: shared by the Effect-wrapped driver (`Sqlite.ts`, used in-process) and the
// standalone native launcher, which runs outside any Effect runtime and calls these directly.
import type { DatabaseSync } from "node:sqlite";

/**
 * The one-row table a pin's `SELECT` reads, created lazily so a fresh digest lock file works.
 * Checks first and only writes when actually missing: every pin after the first ever one on a
 * digest finds the table and row already there, so it never takes a write-intent lock at all,
 * which would otherwise transiently conflict with another concurrent reader's own no-op check.
 */
export const ensurePinTable = (connection: DatabaseSync): void => {
  const hasTable = connection
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pin'")
    .get();
  if (hasTable === undefined)
    connection.exec("CREATE TABLE IF NOT EXISTS pin (id INTEGER PRIMARY KEY)");
  const hasRow = connection.prepare("SELECT 1 FROM pin LIMIT 1").get();
  if (hasRow === undefined) connection.exec("INSERT OR IGNORE INTO pin (id) VALUES (1)");
};

/**
 * Takes a SHARED read lock: a deferred `BEGIN` plus a real `SELECT`, held until the connection
 * commits or closes. Multiple SHARED holders coexist; only a concurrent EXCLUSIVE holder (a
 * retirement sweep) contends, surfacing as SQLite's busy errcode under `busy_timeout = 0`.
 */
export const takeSharedLockSync = (connection: DatabaseSync): void => {
  connection.exec("PRAGMA busy_timeout = 0");
  ensurePinTable(connection);
  connection.exec("BEGIN");
  try {
    connection.prepare("SELECT id FROM pin LIMIT 1").get();
  } catch (error) {
    // A deferred `BEGIN` takes no lock by itself; only this `SELECT` does, so a failure here
    // still leaves the transaction open. Roll back before propagating, or a retry on this same
    // connection would hit "cannot start a transaction within a transaction" instead of busy.
    connection.exec("ROLLBACK");
    throw error;
  }
};
