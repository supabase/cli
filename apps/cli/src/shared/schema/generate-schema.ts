import { Clock, Effect } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { MigrationRepository } from "../migrations/migration-repository.service.ts";
import { MigrationRunner } from "../migrations/migration-runner.service.ts";
import { digestVersions } from "./schema-digest.ts";
import { SchemaDraftConflictError, SchemaEngineError } from "./schema-errors.ts";
import { formatPlanSummary } from "./schema-output.ts";
import { assertPlanActionable } from "./schema-plan-gate.ts";
import { SchemaStateStore } from "./schema-state.service.ts";
import type { SchemaCommandResult } from "./schema-types.ts";
import { SchemaWorkspace } from "./schema-workspace.service.ts";
import { PgDeltaSchemaEngine } from "./pg-delta-engine.service.ts";

export type GenerateSchemaInput = {
  readonly name?: string;
  readonly dryRun: boolean;
  readonly baseline: boolean;
};

export const generateSchema = Effect.fn("schema.generate")(function* (input: GenerateSchemaInput) {
  const workspace = yield* SchemaWorkspace;
  const state = yield* SchemaStateStore;
  const engine = yield* PgDeltaSchemaEngine;
  const migrations = yield* MigrationRepository;
  const runner = yield* MigrationRunner;

  const declarations = yield* workspace.readDeclarationFiles;
  const localMigrations = yield* migrations.listLocal;
  const name = input.name ?? (input.baseline ? "initial_schema" : "schema");

  return yield* state.withLock(
    Effect.scoped(
      Effect.gen(function* () {
        const journal = yield* state.readJournal;
        if (
          journal._tag === "Some" &&
          journal.value.declarativelyAhead &&
          journal.value.generated !== true
        ) {
          const currentHead = digestVersions(localMigrations.map((file) => file.version));
          if (currentHead !== journal.value.startingMigrationHeadDigest) {
            return yield* new SchemaDraftConflictError({
              detail: "Migration files changed while a declarative draft is active.",
              suggestion:
                "Reset the local database, discard the draft, or restore the migration files from before schema apply.",
            });
          }
        }

        const sourceShadow = yield* engine.provisionShadow;
        const desiredShadow = yield* engine.provisionShadow;

        const sourcePool = yield* acquireDatabasePool(sourceShadow.url);
        const desiredPool = yield* acquireDatabasePool(desiredShadow.url);

        if (!input.baseline) {
          yield* runner.applyPending(sourcePool, localMigrations);
        }

        const plan = yield* engine.planFiles({
          targetPool: sourcePool,
          shadowPool: desiredPool,
          files: declarations,
          allowDrops: true,
        });

        if (!input.dryRun) {
          yield* assertPlanActionable(plan);
        }

        const summary = formatPlanSummary({
          title: "Schema plan",
          source: `migrations@${plan.sourceFingerprint.slice(0, 8)}`,
          desired: `declarations@${plan.desiredFingerprint.slice(0, 8)}`,
          target: "clean migration replay (no live database writes)",
          plan,
        });

        if (input.dryRun || !plan.changes) {
          if (!input.dryRun && !plan.changes) {
            yield* state.clearJournal;
          }
          return {
            status: plan.changes ? "needs_approval" : "clean",
            message: plan.changes
              ? `${summary}\nResult: dry-run; nothing was changed`
              : "Declarations already match migration replay.",
            data: {
              status: plan.changes ? "needs_approval" : "clean",
              plan_id: plan.planId,
              source_fingerprint: plan.sourceFingerprint,
              desired_fingerprint: plan.desiredFingerprint,
              hazards: plan.hazards,
              files_written: [],
              mutated_database: false,
              mutated_files: false,
              next_actions: plan.changes ? [`supabase schema generate --name ${name}`] : [],
            },
            nextActions: plan.changes ? [`supabase schema generate --name ${name}`] : [],
            mutatedDatabase: false,
            mutatedFiles: false,
          } satisfies SchemaCommandResult;
        }

        const written = yield* migrations.writeGenerated({
          name,
          baseMillis: yield* Clock.currentTimeMillis,
          files: plan.files.map((file) => ({
            suffix: file.suffix,
            sql: file.sql,
            transactional: file.transactional,
          })),
        });

        const persistGenerated = Effect.gen(function* () {
          const verifyShadow = yield* engine.provisionShadow;
          const verifySource = yield* acquireDatabasePool(verifyShadow.url);
          const verifyDesired = yield* engine.provisionShadow;
          const verifyDesiredPool = yield* acquireDatabasePool(verifyDesired.url);
          const allMigrations = yield* migrations.listLocal;
          yield* runner.applyPending(verifySource, allMigrations);
          const verify = yield* engine.planFiles({
            targetPool: verifySource,
            shadowPool: verifyDesiredPool,
            files: declarations,
            allowDrops: true,
          });
          if (verify.changes) {
            return yield* new SchemaEngineError({
              detail: "Generated migrations did not converge to the declared schema.",
              suggestion: "Inspect the generated files and rerun schema generate.",
            });
          }

          yield* state.clearJournal;

          return {
            status: "generated",
            message: `${summary}\nWrote ${written.map((file) => file.fileName).join(", ")}`,
            data: {
              status: "generated",
              plan_id: plan.planId,
              hazards: plan.hazards,
              files_written: written.map((file) => file.fileName),
              mutated_database: false,
              mutated_files: true,
              next_actions: [
                "Review the migration files, commit them, then deploy with migrations push.",
              ],
            },
            nextActions: [
              "Review the migration files, commit them, then deploy with migrations push.",
            ],
            mutatedDatabase: false,
            mutatedFiles: true,
          } satisfies SchemaCommandResult;
        });

        return yield* persistGenerated.pipe(Effect.tapError(() => migrations.remove(written)));
      }),
    ),
  );
});
