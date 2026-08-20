import { Effect, FileSystem } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { parseTargetSelector } from "../database/database-target.ts";
import { SchemaWorkspaceIoError } from "../schema/schema-errors.ts";
import { formatPlanSummary, withCoverageMessage } from "../schema/schema-output.ts";
import type { SchemaCommandResult } from "../schema/schema-types.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";

export type DiffMigrationsInput = {
  readonly against?: string;
  readonly file?: string;
};

export const diffMigrations = Effect.fn("migrations.diff")(function* (input: DiffMigrationsInput) {
  const targets = yield* DatabaseTargetResolver;
  const engine = yield* PgDeltaSchemaEngine;
  const live = yield* targets.resolve(parseTargetSelector(input.against ?? "local"));

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
      const nextActions = plan.changes ? nextActionsForDiff(input.against ?? "local") : [];

      return {
        status: plan.changes ? "drift" : "clean",
        message: plan.changes
          ? `${summary}\nResult: preview only; nothing was changed`
          : withCoverageMessage("Live database matches migration replay.", plan),
        data: {
          status: plan.changes ? "drift" : "clean",
          plan_id: plan.planId,
          hazards: plan.hazards,
          sql: plan.files.map((file) => file.sql).join("\n\n"),
          file: input.file,
          mutated_database: false,
          mutated_files: input.file !== undefined,
          next_actions: nextActions,
        },
        nextActions,
        mutatedDatabase: false,
        mutatedFiles: input.file !== undefined,
      } satisfies SchemaCommandResult;
    }),
  );
});

function nextActionsForDiff(against: string): ReadonlyArray<string> {
  if (against === "local") {
    return [
      "If this extra shape came from supabase/schemas, create a migration with `supabase schema generate --name <feature>`.",
      "To record the live database as migration files instead, run `supabase migrations pull --from local`.",
    ];
  }
  if (against === "linked") {
    return [
      "If the linked project has extra shape you want as files, record it with `supabase migrations pull`.",
    ];
  }
  return [
    "If that database has extra shape you want as files, record it with `supabase migrations pull --from <connection-string>`.",
  ];
}
