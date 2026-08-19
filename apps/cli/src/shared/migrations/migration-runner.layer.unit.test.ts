import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import type { Pool } from "pg";
import { migrationRunnerLayer } from "./migration-runner.layer.ts";
import { MigrationRunner } from "./migration-runner.service.ts";

class PostgresQueryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function fakePool(
  query: (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Promise<{ rows: Array<{ version: string; name: string }> }>,
): Pool {
  return { query } as Pool;
}

const sampleFile = {
  version: "20260101000000",
  name: "init",
  fileName: "20260101000000_init.sql",
  absolutePath: "/tmp/migrations/20260101000000_init.sql",
  content: "select 1;",
  transactional: true,
};

describe("migrationRunnerLayer.listRemote", () => {
  it.live("does not create migration history", () => {
    const seen: Array<string> = [];
    return Effect.gen(function* () {
      const runner = yield* MigrationRunner;
      const rows = yield* runner.listRemote(
        fakePool(async (sql) => {
          seen.push(sql);
          return { rows: [{ version: "20260101000000", name: "init" }] };
        }),
      );
      expect(rows).toEqual([{ version: "20260101000000", name: "init" }]);
      expect(seen.some((sql) => sql.includes("CREATE SCHEMA"))).toBe(false);
      expect(seen.some((sql) => sql.includes("CREATE TABLE"))).toBe(false);
    }).pipe(Effect.provide(migrationRunnerLayer));
  });

  it.live("returns empty history when the table is missing", () =>
    Effect.gen(function* () {
      const runner = yield* MigrationRunner;
      const rows = yield* runner.listRemote(
        fakePool(async () => {
          throw new PostgresQueryError(
            "42P01",
            `relation "supabase_migrations.schema_migrations" does not exist`,
          );
        }),
      );
      expect(rows).toEqual([]);
    }).pipe(Effect.provide(migrationRunnerLayer)),
  );

  it.live("returns empty history when the schema is missing", () =>
    Effect.gen(function* () {
      const runner = yield* MigrationRunner;
      const rows = yield* runner.listRemote(
        fakePool(async () => {
          throw new PostgresQueryError("3F000", `schema "supabase_migrations" does not exist`);
        }),
      );
      expect(rows).toEqual([]);
    }).pipe(Effect.provide(migrationRunnerLayer)),
  );

  it.live("reads version-only history when the name column is missing", () => {
    const seen: Array<string> = [];
    return Effect.gen(function* () {
      const runner = yield* MigrationRunner;
      const rows = yield* runner.listRemote(
        fakePool(async (sql) => {
          seen.push(sql);
          if (sql.includes("coalesce(name")) {
            throw new PostgresQueryError("42703", `column "name" does not exist`);
          }
          return { rows: [{ version: "20260101000000", name: "" }] };
        }),
      );
      expect(rows).toEqual([{ version: "20260101000000", name: "" }]);
      expect(seen.some((sql) => sql.includes("CREATE"))).toBe(false);
    }).pipe(Effect.provide(migrationRunnerLayer));
  });

  it.live("propagates other query failures", () =>
    Effect.gen(function* () {
      const runner = yield* MigrationRunner;
      const exit = yield* runner
        .listRemote(
          fakePool(async () => {
            throw new PostgresQueryError("42703", `column "version" does not exist`);
          }),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(migrationRunnerLayer)),
  );
});

describe("migrationRunnerLayer.markApplied", () => {
  it.live("inserts missing history rows", () => {
    const statements: Array<string> = [];
    return Effect.gen(function* () {
      const runner = yield* MigrationRunner;
      yield* runner.markApplied(
        fakePool(async (sql) => {
          statements.push(sql);
          if (sql.includes("SELECT version")) {
            return { rows: [] };
          }
          return { rows: [] };
        }),
        [sampleFile],
      );
      expect(statements.some((sql) => sql.includes("INSERT INTO"))).toBe(true);
    }).pipe(Effect.provide(migrationRunnerLayer));
  });

  it.live("skips versions already present", () => {
    const inserts: Array<ReadonlyArray<unknown> | undefined> = [];
    return Effect.gen(function* () {
      const runner = yield* MigrationRunner;
      yield* runner.markApplied(
        fakePool(async (sql, params) => {
          if (sql.includes("INSERT INTO")) {
            inserts.push(params);
          }
          if (sql.includes("SELECT version")) {
            return { rows: [{ version: sampleFile.version, name: sampleFile.name }] };
          }
          return { rows: [] };
        }),
        [sampleFile],
      );
      expect(inserts).toEqual([]);
    }).pipe(Effect.provide(migrationRunnerLayer));
  });
});
