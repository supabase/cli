import { DatabaseSync } from "node:sqlite";
import type { Layer } from "effect";
import type { ManagedStackRepository } from "./repository.ts";
import {
  hardenManagedRegistryFile,
  sqliteManagedStackRepositoryLayer,
  type ManagedSqliteDatabase,
} from "./sqlite.ts";

const openDatabase = (path: string): ManagedSqliteDatabase => {
  hardenManagedRegistryFile(path);
  const database = new DatabaseSync(path);
  return {
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
};

export const nodeSqliteManagedStackRepositoryLayer = (
  path: string,
): Layer.Layer<ManagedStackRepository> =>
  sqliteManagedStackRepositoryLayer(() => openDatabase(path));
