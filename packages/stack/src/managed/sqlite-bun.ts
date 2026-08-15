import { Database } from "bun:sqlite";
import type { Layer } from "effect";
import type { ManagedStackRepository } from "./repository.ts";
import type { IncompatibleManagedRegistryError } from "./model.ts";
import {
  hardenManagedRegistryFile,
  sqliteManagedStackRepositoryLayer,
  type ManagedSqliteDatabase,
} from "./sqlite.ts";

const openDatabase = (path: string): ManagedSqliteDatabase => {
  hardenManagedRegistryFile(path);
  const database = new Database(path, { create: true });
  return {
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
};

export const bunSqliteManagedStackRepositoryLayer = (
  path: string,
): Layer.Layer<ManagedStackRepository, IncompatibleManagedRegistryError> =>
  sqliteManagedStackRepositoryLayer(() => openDatabase(path));
