import { Effect } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import type { MigrationFile } from "./migration-file.ts";
import { MigrationRunner, type MigrationApplyResult } from "./migration-runner.service.ts";
import type { Pool } from "pg";

export const applyLocalPending = Effect.fn("migrations.applyLocalPending")(function* (
  pool: Pool,
  local: ReadonlyArray<MigrationFile>,
) {
  const runner = yield* MigrationRunner;
  const engine = yield* PgDeltaSchemaEngine;
  const history = yield* runner.listRemote(pool);
  const present = new Set(history.map((row) => row.version));
  const pending = local.filter((file) => !present.has(file.version));
  if (pending.length === 0) {
    return {
      applied: [],
      skipped: local.map((file) => file.version),
    } satisfies MigrationApplyResult;
  }

  const shadow = yield* engine.provisionShadow;
  const shadowPool = yield* acquireDatabasePool(shadow.url);
  yield* runner.applyPending(shadowPool, local);
  const drift = yield* engine.diffPools({
    sourcePool: shadowPool,
    desiredPool: pool,
    allowDrops: true,
  });
  if (!drift.changes) {
    yield* runner.markApplied(pool, pending);
    return {
      applied: [],
      recorded: pending.map((file) => file.version),
      skipped: local.filter((file) => present.has(file.version)).map((file) => file.version),
    } satisfies MigrationApplyResult;
  }

  return yield* runner.applyPending(pool, local);
});
