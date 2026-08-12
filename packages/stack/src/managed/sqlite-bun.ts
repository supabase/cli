import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createSqliteManagedStackRepository, type ManagedSqliteDatabase } from "./sqlite.ts";

export const openBunSqliteManagedStackRepository = (path: string) => {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const database = new Database(path, { create: true });
  if (path !== ":memory:") {
    // Restrict before the WAL conversion so the -wal/-shm sidecars inherit the
    // owner-only mode; the registry stores workspace paths, ports, and
    // credential references that other local users must not read.
    chmodSync(path, 0o600);
  }
  const adapter: ManagedSqliteDatabase = {
    exec(sql) {
      database.exec(sql);
    },
    prepare(sql) {
      const statement = database.query(sql);
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
