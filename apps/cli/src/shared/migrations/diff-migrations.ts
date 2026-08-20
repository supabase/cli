import { Effect, FileSystem } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { parseTargetSelector } from "../database/database-target.ts";
import { SchemaTargetRequiredError, SchemaWorkspaceIoError } from "../schema/schema-errors.ts";
import { formatPlanSummary } from "../schema/schema-output.ts";
import type { SchemaCommandResult } from "../schema/schema-types.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";

export type DiffMigrationsInput = {
  readonly against?: string;
  readonly file?: string;
};

export const diffMigrations = Effect.fn("migrations.diff")(function* (input: DiffMigrationsInput) {
  if (input.against === undefined) {
    return yield* new SchemaTargetRequiredError({
      detail: "migrations diff requires --against.",
      suggestion: "Pass --against local, --against linked, or --against <connection-string>.",
    });
  }

  const targets = yield* DatabaseTargetResolver;
  const engine = yield* PgDeltaSchemaEngine;
  const live = yield* targets.resolve(parseTargetSelector(input.against));

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const livePool = yield* acquireDatabasePool(live.connectionString);
      const shadow = yield* engine.provisionMigrations;
      const sourcePool = yield* acquireDatabasePool(shadow.url);
      const plan = yield* engine.diffPools({
        sourcePool,
        desiredPool: livePool,
        allowDrops: true,
      });

      if (input.file !== undefined) {
        const fs = yield* FileSystem.FileSystem;
        const sql = plan.files.map((file) => file.sql).join("\n\n");
        yield* fs.writeFileString(input.file, sql).pipe(
          Effect.mapError(
            (error) =>
              new SchemaWorkspaceIoError({
                detail: `Failed to write ${input.file}: ${error.message}`,
                suggestion: "Check the output path and retry.",
              }),
          ),
        );
      }

      const summary = formatPlanSummary({
        title: "Migrations diff",
        source: `migrations@${plan.sourceFingerprint.slice(0, 8)}`,
        desired: `live@${plan.desiredFingerprint.slice(0, 8)}`,
        target: live.identity,
        plan,
      });

      return {
        status: plan.changes ? "drift" : "clean",
        message: plan.changes
          ? `${summary}\nResult: preview only; nothing was changed`
          : "Live database matches migration replay.",
        data: {
          status: plan.changes ? "drift" : "clean",
          plan_id: plan.planId,
          hazards: plan.hazards,
          sql: plan.files.map((file) => file.sql).join("\n\n"),
          file: input.file,
          mutated_database: false,
          mutated_files: input.file !== undefined,
          next_actions: plan.changes ? ["supabase migrations pull"] : [],
        },
        nextActions: plan.changes ? ["supabase migrations pull"] : [],
        mutatedDatabase: false,
        mutatedFiles: input.file !== undefined,
      } satisfies SchemaCommandResult;
    }),
  );
});
