import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteManagedStackRepository, type ManagedSqliteDatabase } from "./sqlite.ts";

export const openNodeSqliteManagedStackRepository = (path: string) => {
  if (path !== ":memory:") {
    // The registry stores workspace paths, ports, and credential references
    // that other local users must not read. Pre-create the database file with
    // an owner-only mode so it never exists with umask-derived permissions,
    // and retighten both it and a directory left looser by an earlier build.
    // Doing this before the WAL conversion also makes the -wal/-shm sidecars
    // inherit the owner-only mode.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
  }
  const database = new DatabaseSync(path);
  const adapter: ManagedSqliteDatabase = {
    exec(sql) {
      database.exec(sql);
    },
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        run(parameters = []) {
          statement.run(...parameters);
        },
        get(parameters = []) {
          return statement.get(...parameters) ?? undefined;
        },
        all(parameters = []) {
          return statement.all(...parameters);
        },
      };
    },
    close() {
      database.close();
    },
  };
  try {
    return createSqliteManagedStackRepository(adapter);
  } catch (error: unknown) {
    database.close();
    throw error;
  }
};
