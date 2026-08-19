import { Clock, Effect } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { parseTargetSelector } from "../database/database-target.ts";
import { formatPlanSummary } from "../schema/schema-output.ts";
import type { SchemaCommandResult } from "../schema/schema-types.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import { MigrationRepository } from "./migration-repository.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";

export type PullMigrationsInput = {
  readonly from?: string;
  readonly name?: string;
};

export const pullMigrations = Effect.fn("migrations.pull")(function* (input: PullMigrationsInput) {
  const targets = yield* DatabaseTargetResolver;
  const engine = yield* PgDeltaSchemaEngine;
  const repository = yield* MigrationRepository;
  const runner = yield* MigrationRunner;
  const remote = yield* targets.resolve(parseTargetSelector(input.from ?? "linked"));
  const migrations = yield* repository.listLocal;
  const name = input.name ?? "remote_schema";

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const remotePool = yield* acquireDatabasePool(remote.connectionString);
      const shadow = yield* engine.provisionShadow;
      const sourcePool = yield* acquireDatabasePool(shadow.url);
      yield* runner.applyPending(sourcePool, migrations);
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

      const summary = formatPlanSummary({
        title: "Migrations pull",
        source: `migrations@${plan.sourceFingerprint.slice(0, 8)}`,
        desired: `remote@${plan.desiredFingerprint.slice(0, 8)}`,
        target: remote.identity,
        plan,
      });

      return {
        status: "generated",
        message: `${summary}\nWrote ${written.map((file) => file.fileName).join(", ")}`,
        data: {
          status: "generated",
          plan_id: plan.planId,
          files_written: written.map((file) => file.fileName),
          hazards: plan.hazards,
          mutated_files: true,
          mutated_database: false,
          next_actions: ["Review the pulled migration, then apply it locally if needed."],
        },
        nextActions: ["Review the pulled migration, then apply it locally if needed."],
        mutatedDatabase: false,
        mutatedFiles: true,
      } satisfies SchemaCommandResult;
    }),
  );
});
