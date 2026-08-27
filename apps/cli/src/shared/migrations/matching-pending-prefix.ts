import { Effect } from "effect";
import type { Pool } from "pg";
import { SchemaEngineError } from "../schema/schema-errors.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import type { MigrationFile } from "./migration-file.ts";
import { MigrationRunner } from "./migration-runner.service.ts";

export const findMatchingPendingPrefix = Effect.fn("migrations.findMatchingPendingPrefix")(
  function* (
    shadowPool: Pool,
    livePool: Pool,
    known: ReadonlyArray<MigrationFile>,
    pending: ReadonlyArray<MigrationFile>,
    opts: { readonly failClosed?: boolean } = {},
  ) {
    const runner = yield* MigrationRunner;
    const engine = yield* PgDeltaSchemaEngine;
    let recorded: ReadonlyArray<MigrationFile> = [];
    for (const [index] of pending.entries()) {
      const prefix = pending.slice(0, index + 1);
      const apply = runner.applyPending(shadowPool, [...known, ...prefix]);
      const applied =
        opts.failClosed === true
          ? yield* apply
          : yield* apply.pipe(
              Effect.catchIf(
                (error): error is SchemaEngineError =>
                  error._tag === "SchemaEngineError" && error.detail.startsWith("Failed applying"),
                () => Effect.succeed(undefined),
              ),
            );
      if (applied === undefined) {
        break;
      }
      const drift = yield* engine.diffPools({
        sourcePool: shadowPool,
        desiredPool: livePool,
        allowDrops: true,
      });
      if (!drift.changes) {
        recorded = prefix;
      }
    }
    return recorded;
  },
);
