import { Effect } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { SchemaHistoryConflictError } from "../schema/schema-errors.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import type { MigrationFile } from "./migration-file.ts";
import { findMatchingPendingPrefix } from "./matching-pending-prefix.ts";
import { formatHistoryConflict } from "./migration-repair-suggest.ts";
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
      recorded: [],
      skipped: local.map((file) => file.version),
    } satisfies MigrationApplyResult;
  }

  const remoteOnly = history.filter((row) => !local.some((file) => file.version === row.version));
  if (remoteOnly.length > 0) {
    return yield* new SchemaHistoryConflictError(
      formatHistoryConflict({
        remoteOnly: remoteOnly.map((row) => row.version),
        pending: pending.map((file) => file.version),
        flags: { local: true },
      }),
    );
  }

  const already = local.filter((file) => present.has(file.version));
  const shadow = yield* engine.provisionPlatform;
  const shadowPool = yield* acquireDatabasePool(shadow.url);
  if (already.length > 0) {
    yield* runner.applyPending(shadowPool, already);
  }

  const recorded = yield* findMatchingPendingPrefix(shadowPool, pool, already, pending);

  if (recorded.length === pending.length) {
    yield* runner.markApplied(pool, pending);
    return {
      applied: [],
      recorded: pending.map((file) => file.version),
      skipped: already.map((file) => file.version),
    } satisfies MigrationApplyResult;
  }

  if (recorded.length > 0) {
    yield* runner.markApplied(pool, recorded);
  }

  const result = yield* runner.applyPending(pool, local);
  return {
    ...result,
    recorded: recorded.map((file) => file.version),
  } satisfies MigrationApplyResult;
});
