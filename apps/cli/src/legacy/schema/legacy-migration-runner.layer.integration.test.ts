import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import type { Pool, PoolClient } from "pg";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { MigrationRunner } from "../../shared/migrations/migration-runner.service.ts";
import {
  SchemaEngineError,
  SchemaMigrationsPrivilegeError,
} from "../../shared/schema/schema-errors.ts";
import { legacyMigrationRunnerLayer } from "./legacy-migration-runner.layer.ts";

const local = {
  version: "20260101000000",
  name: "init",
  fileName: "20260101000000_init.sql",
  absolutePath: "/tmp/migrations/20260101000000_init.sql",
  content: "select 1;",
  transactional: true,
};

function queryFailPool(error: Error): Pool {
  const client = {
    query: async () => {
      throw error;
    },
    release: () => undefined,
  };
  return {
    connect: async () => client as unknown as PoolClient,
    options: { connectionString: "postgresql://cli_login_abc.ref:pw@127.0.0.1:1/postgres" },
  } as Pool;
}

function historyPool(versions: ReadonlyArray<string>): Pool {
  const client = {
    query: async (sql: string) => {
      if (sql.includes("statements")) {
        return {
          rows: versions.map((version) => ({
            version,
            name: "init",
            statements: ["select 1"],
          })),
        };
      }
      if (sql.includes("SELECT version")) {
        return { rows: versions.map((version) => ({ version, name: "" })) };
      }
      if (sql.includes("SHOW server_version")) {
        return { rows: [{ server_version: "17.6" }] };
      }
      return { rows: [] };
    },
    release: () => undefined,
  };
  return {
    connect: async () => client as unknown as PoolClient,
    options: { connectionString: "postgresql://postgres:postgres@127.0.0.1:1/postgres" },
  } as Pool;
}

describe("legacyMigrationRunnerLayer", () => {
  it.live("is a no-op when remote is strictly ahead and nothing is pending", () => {
    const out = mockOutput({ interactive: false });
    return Effect.gen(function* () {
      const runner = yield* MigrationRunner;
      const result = yield* runner.applyPending(historyPool(["19990101000000", local.version]), [
        local,
      ]);
      expect(result.applied).toEqual([]);
      expect(result.skipped).toEqual([local.version]);
    }).pipe(
      Effect.provide(legacyMigrationRunnerLayer),
      Effect.provide(out.layer),
      Effect.provide(BunServices.layer),
    );
  });

  it.live("maps 42501 on supabase_migrations to SchemaMigrationsPrivilegeError", () => {
    const out = mockOutput({ interactive: false });
    const denied = Object.assign(new Error("permission denied for schema supabase_migrations"), {
      code: "42501",
    });
    return Effect.gen(function* () {
      const runner = yield* MigrationRunner;
      const error = yield* runner.listRemote(queryFailPool(denied)).pipe(Effect.flip);
      expect(error).toBeInstanceOf(SchemaMigrationsPrivilegeError);
      expect(error.message).toContain("permission denied for schema supabase_migrations");
      expect(error.suggestion).toBe("Set SUPABASE_DB_PASSWORD for the postgres role, then retry.");
      expect(error.suggestion).not.toContain("--password");
    }).pipe(
      Effect.provide(legacyMigrationRunnerLayer),
      Effect.provide(out.layer),
      Effect.provide(BunServices.layer),
    );
  });

  it.live("keeps unrelated privilege failures as SchemaEngineError", () => {
    const out = mockOutput({ interactive: false });
    const denied = Object.assign(new Error('permission denied to set role "postgres"'), {
      code: "42501",
    });
    return Effect.gen(function* () {
      const runner = yield* MigrationRunner;
      const error = yield* runner.listRemote(queryFailPool(denied)).pipe(Effect.flip);
      expect(error).toBeInstanceOf(SchemaEngineError);
      expect(error).not.toBeInstanceOf(SchemaMigrationsPrivilegeError);
    }).pipe(
      Effect.provide(legacyMigrationRunnerLayer),
      Effect.provide(out.layer),
      Effect.provide(BunServices.layer),
    );
  });

  it.live("lists remote statements for fetch-pull", () => {
    const out = mockOutput({ interactive: false });
    return Effect.gen(function* () {
      const runner = yield* MigrationRunner;
      const rows = yield* runner.listRemoteStatements(historyPool(["20260101000000"]));
      expect(rows).toEqual([{ version: "20260101000000", name: "init", statements: ["select 1"] }]);
      expect(yield* runner.showServerVersion(historyPool([]))).toBe("17.6");
    }).pipe(
      Effect.provide(legacyMigrationRunnerLayer),
      Effect.provide(out.layer),
      Effect.provide(BunServices.layer),
    );
  });

  it.live("conflicts when remote-only versions and pending files both exist", () => {
    const out = mockOutput({ interactive: false });
    const pending = { ...local, version: "20260101000001", fileName: "20260101000001_next.sql" };
    return Effect.gen(function* () {
      const runner = yield* MigrationRunner;
      const exit = yield* runner
        .applyPending(historyPool(["19990101000000"]), [pending])
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(
      Effect.provide(legacyMigrationRunnerLayer),
      Effect.provide(out.layer),
      Effect.provide(BunServices.layer),
    );
  });
});
