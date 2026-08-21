import { Clock, Effect } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { parseTargetSelector } from "../database/database-target.ts";
import {
  formatMigrationFilePath,
  formatNextAction,
  withPlanSummary,
} from "../schema/schema-output.ts";
import type { SchemaCommandResult } from "../schema/schema-types.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import { formatMigrationRepairCommand, repairFlagsForTarget } from "./migration-repair-suggest.ts";
import { MigrationRepository } from "./migration-repository.service.ts";

export type PullMigrationsInput = {
  readonly from?: string;
  readonly name?: string;
};

export const pullMigrations = Effect.fn("migrations.pull")(function* (input: PullMigrationsInput) {
  const targets = yield* DatabaseTargetResolver;
  const engine = yield* PgDeltaSchemaEngine;
  const repository = yield* MigrationRepository;
  const remote = yield* targets.resolve(parseTargetSelector(input.from ?? "linked"));
  const name = input.name ?? "remote_schema";

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const remotePool = yield* acquireDatabasePool(remote.connectionString);
      const shadow = yield* engine.provisionMigrations;
      const sourcePool = yield* acquireDatabasePool(shadow.url);
      const plan = yield* engine.diffPools({
        sourcePool,
        desiredPool: remotePool,
        allowDrops: true,
      });

      if (!plan.changes) {
        return {
          status: "clean",
          message: "No remote drift to record.",
          data: {
            status: "clean",
            plan_id: plan.planId,
            source_fingerprint: plan.sourceFingerprint,
            desired_fingerprint: plan.desiredFingerprint,
            mutated_files: false,
            mutated_database: false,
          },
          nextActions: [],
          mutatedDatabase: false,
          mutatedFiles: false,
        } satisfies SchemaCommandResult;
      }

      const written = yield* repository.writeGenerated({
        name,
        baseMillis: yield* Clock.currentTimeMillis,
        files: plan.files.map((file) => ({
          suffix: file.suffix,
          sql: file.sql,
          transactional: file.transactional,
        })),
      });

      const nextActions = [
        formatNextAction(
          "to record it as applied",
          formatMigrationRepairCommand({
            status: "applied",
            versions: written.map((file) => file.version),
            flags: repairFlagsForTarget(remote),
          }),
        ),
      ];

      return {
        status: "generated",
        message: withPlanSummary(
          `Wrote ${written.map((file) => formatMigrationFilePath(file.fileName)).join(", ")}`,
          plan,
        ),
        data: {
          status: "generated",
          plan_id: plan.planId,
          source_fingerprint: plan.sourceFingerprint,
          desired_fingerprint: plan.desiredFingerprint,
          files_written: written.map((file) => file.fileName),
          hazards: plan.hazards,
          mutated_files: true,
          mutated_database: false,
          next_actions: nextActions,
        },
        nextActions,
        mutatedDatabase: false,
        mutatedFiles: true,
      } satisfies SchemaCommandResult;
    }),
  );
});
