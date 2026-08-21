import { Effect, FileSystem } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { parseTargetSelector } from "../database/database-target.ts";
import { SchemaWorkspaceIoError } from "../schema/schema-errors.ts";
import { formatNextAction, withCoverageMessage, withPlanSummary } from "../schema/schema-output.ts";
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

      const nextActions = plan.changes ? nextActionsForDiff(input.against ?? "local") : [];

      return {
        status: plan.changes ? "drift" : "clean",
        message: plan.changes
          ? withPlanSummary("Preview only; nothing was changed.", plan)
          : withCoverageMessage("Live database matches migration replay.", plan),
        data: {
          status: plan.changes ? "drift" : "clean",
          plan_id: plan.planId,
          source_fingerprint: plan.sourceFingerprint,
          desired_fingerprint: plan.desiredFingerprint,
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
  const command =
    against === "linked"
      ? "supabase migrations pull"
      : against === "local"
        ? "supabase migrations pull --from local"
        : "supabase migrations pull --from <connection-string>";
  return [formatNextAction("to capture remote shape", command)];
}
