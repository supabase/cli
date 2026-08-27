import { Effect } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { SchemaHistoryConflictError } from "../schema/schema-errors.ts";
import {
  imageExtensionCatchupAlreadyPresent,
  prepareDeclarativeShadow,
} from "../schema/prepare-declarative-shadow.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import type { MigrationFile } from "./migration-file.ts";
import { findMatchingPendingPrefix } from "./matching-pending-prefix.ts";
import { formatHistoryConflict } from "./migration-repair-suggest.ts";
import { emptyPendingMigrationError } from "./privilege-offer.ts";
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

  const empty = emptyPendingMigrationError(pending);
  if (empty !== undefined) {
    return yield* empty;
  }

  const already = local.filter((file) => present.has(file.version));
  const installed = new Set(yield* runner.listInstalledExtensions(pool));
  // First-push catchup recreates image extensions already on the local catalog.
  const leftoverCatchup = pending.filter((file) =>
    imageExtensionCatchupAlreadyPresent(file.content, installed),
  );
  const leftoverVersions = new Set(leftoverCatchup.map((file) => file.version));
  const scanPending = pending.filter((file) => !leftoverVersions.has(file.version));

  if (scanPending.length === 0) {
    yield* runner.markApplied(pool, leftoverCatchup);
    return {
      applied: [],
      recorded: leftoverCatchup.map((file) => file.version),
      skipped: already.map((file) => file.version),
    } satisfies MigrationApplyResult;
  }

  const shadow = yield* engine.provisionPlatform;
  const shadowPool = yield* acquireDatabasePool(shadow.url);
  yield* prepareDeclarativeShadow(
    shadowPool,
    [...already, ...scanPending].map((file) => ({ name: file.fileName, sql: file.content })),
  );

  const recorded = yield* findMatchingPendingPrefix(shadowPool, pool, already, scanPending, {
    failClosed: true,
  });

  const toRecord = [...leftoverCatchup, ...recorded];
  if (toRecord.length > 0) {
    yield* runner.markApplied(pool, toRecord);
  }

  const remaining = scanPending.slice(recorded.length);
  // Full local inventory: applyPending treats a partial list as remote-only history.
  const result =
    remaining.length === 0
      ? { applied: [], skipped: already.map((file) => file.version) }
      : yield* runner.applyPending(pool, local);
  return {
    ...result,
    recorded: toRecord.map((file) => file.version),
  } satisfies MigrationApplyResult;
});
