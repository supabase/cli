import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import type { Pool, PoolClient } from "pg";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { MigrationRunner } from "../../shared/migrations/migration-runner.service.ts";
import { legacyMigrationRunnerLayer } from "./legacy-migration-runner.layer.ts";

const local = {
  version: "20260101000000",
  name: "init",
  fileName: "20260101000000_init.sql",
  absolutePath: "/tmp/migrations/20260101000000_init.sql",
  content: "select 1;",
  transactional: true,
};

function historyPool(versions: ReadonlyArray<string>): Pool {
  const client = {
    query: async (sql: string) => {
      if (sql.includes("SELECT version")) {
        return { rows: versions.map((version) => ({ version, name: "" })) };
      }
      return { rows: [] };
    },
    release: () => undefined,
  };
  return {
    connect: async () => client as PoolClient,
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
