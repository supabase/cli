import { Effect, FileSystem } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { parseTargetSelector } from "../database/database-target.ts";
import { SchemaEmptyHistoryReplayError, SchemaWorkspaceIoError } from "../schema/schema-errors.ts";
import { formatPlanSql } from "../schema/schema-body.ts";
import { formatNextAction, withCoverageMessage, withPlanSummary } from "../schema/schema-output.ts";
import type { SchemaCommandResult } from "../schema/schema-types.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import {
  formatMigrationsDiffFileCommand,
  formatMigrationRepairCommand,
  formatMigrationsPushCommand,
  repairFlagsForTarget,
} from "./migration-repair-suggest.ts";
import { MigrationRepository } from "./migration-repository.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";
import { warnIfRemotePostgresMajorMismatch } from "./remote-postgres.ts";

export type DiffMigrationsInput = {
  readonly against?: string;
  readonly file?: string;
};

export const diffMigrations = Effect.fn("migrations.diff")(function* (input: DiffMigrationsInput) {
  const targets = yield* DatabaseTargetResolver;
  const engine = yield* PgDeltaSchemaEngine;
  const repository = yield* MigrationRepository;
  const runner = yield* MigrationRunner;
  const live = yield* targets.resolve(parseTargetSelector(input.against ?? "local"));

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const livePool = yield* acquireDatabasePool(live.connectionString);
      yield* warnIfRemotePostgresMajorMismatch(livePool, live);
      const localFiles = yield* repository.listLocal;
      const history = yield* runner.listRemote(livePool);
      const flags = repairFlagsForTarget(live);
      if (history.length === 0 && localFiles.length > 0) {
        return yield* new SchemaEmptyHistoryReplayError({
          detail:
            "Remote history is empty, so there are no applied migrations to replay. Local files exist.",
          suggestion: `Apply them first: ${formatMigrationsPushCommand(flags)}. migrations diff is for after histories match.`,
        });
      }
      const remoteVersions = new Set(history.map((row) => row.version));
      const applied = localFiles.filter((file) => remoteVersions.has(file.version));
      const shadow = yield* engine.provisionPlatform;
      const sourcePool = yield* acquireDatabasePool(shadow.url);
      yield* runner.applyPending(sourcePool, applied);
      const plan = yield* engine.diffPools({
        sourcePool,
        desiredPool: livePool,
        allowDrops: true,
      });

      const sql = formatPlanSql(plan);
      if (input.file !== undefined) {
        const fs = yield* FileSystem.FileSystem;
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

      const nextActions = plan.changes ? nextActionsForDiff(live) : [];

      return {
        status: plan.changes ? "drift" : "clean",
        message: plan.changes
          ? withPlanSummary("Preview only; nothing was changed.", plan)
          : withCoverageMessage("Live database matches migration replay.", plan),
        ...(plan.changes && sql.length > 0 ? { body: sql } : {}),
        data: {
          status: plan.changes ? "drift" : "clean",
          plan_id: plan.planId,
          source_fingerprint: plan.sourceFingerprint,
          desired_fingerprint: plan.desiredFingerprint,
          hazards: plan.hazards,
          sql,
          files: plan.files,
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

function nextActionsForDiff(
  target: Parameters<typeof repairFlagsForTarget>[0],
): ReadonlyArray<string> {
  const flags = repairFlagsForTarget(target);
  return [
    formatNextAction("to write a migration file", formatMigrationsDiffFileCommand(flags)),
    formatNextAction(
      "to record it as applied without running SQL",
      formatMigrationRepairCommand({
        status: "applied",
        versions: ["<version>"],
        flags,
      }),
    ),
  ];
}
