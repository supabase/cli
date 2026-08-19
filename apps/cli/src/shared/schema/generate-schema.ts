import { Clock, Effect } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { MigrationRepository } from "../migrations/migration-repository.service.ts";
import { MigrationRunner } from "../migrations/migration-runner.service.ts";
import { digestFileSet, digestVersions } from "./schema-digest.ts";
import { SchemaEngineError } from "./schema-errors.ts";
import { formatPlanSummary } from "./schema-output.ts";
import { assertPlanActionable } from "./schema-plan-gate.ts";
import {
  SCHEMA_ARTIFACT_FORMAT_VERSION,
  SCHEMA_MANAGEMENT_SCOPE,
  SCHEMA_PROFILE_ID,
} from "./schema-paths.ts";
import { SchemaStateStore } from "./schema-state.service.ts";
import type { SchemaCheckpoint, SchemaCommandResult } from "./schema-types.ts";
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
  const targets = yield* DatabaseTargetResolver;
  const migrations = yield* MigrationRepository;
  const runner = yield* MigrationRunner;

  const target = yield* targets.resolve({ kind: "local" });
  const declarations = yield* workspace.readDeclarationFiles;
  const localMigrations = yield* migrations.listLocal;
  const existingCheckpoint = yield* state.readCheckpoint;
  const name = input.name ?? (input.baseline ? "initial_schema" : "schema");

  return yield* state.withLock(
    Effect.scoped(
      Effect.gen(function* () {
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

          const localPool = yield* acquireDatabasePool(target.connectionString);
          // planFiles requires an empty shadow. verifyDesired already holds the
          // loaded declarations, so compare the live catalog against that shape.
          const liveVsDeclared = yield* engine.diffPools({
            sourcePool: localPool,
            desiredPool: verifyDesiredPool,
            allowDrops: true,
          });
          if (!liveVsDeclared.changes) {
            yield* runner.recordApplied(localPool, written);
          }

          const previousGenerated =
            existingCheckpoint._tag === "Some"
              ? (existingCheckpoint.value.generatedMigrationVersions ?? [])
              : [];
          const previousDestructive =
            existingCheckpoint._tag === "Some"
              ? (existingCheckpoint.value.destructiveMigrationVersions ?? [])
              : [];
          const checkpoint: SchemaCheckpoint = {
            version: 1,
            declarativeDigest: digestFileSet(declarations),
            migrationHeadDigest: digestVersions(allMigrations.map((file) => file.version)),
            sourceFingerprint: plan.sourceFingerprint,
            desiredFingerprint: plan.desiredFingerprint,
            profile: SCHEMA_PROFILE_ID,
            scope: SCHEMA_MANAGEMENT_SCOPE,
            engineVersion: plan.engineVersion,
            artifactFormatVersion: SCHEMA_ARTIFACT_FORMAT_VERSION,
            acceptedRenames: plan.acceptedRenames,
            ...(existingCheckpoint._tag === "Some" &&
            existingCheckpoint.value.catalogSnapshot !== undefined
              ? { catalogSnapshot: existingCheckpoint.value.catalogSnapshot }
              : {}),
            lastGenerateName: name,
            lastGenerateHazards: {
              kinds: plan.hazards.kinds,
              destructive: plan.hazards.destructive,
              rewrite: plan.hazards.rewrite,
              coverageGaps: plan.hazards.coverageGaps,
            },
            generatedMigrationVersions: [
              ...new Set([...previousGenerated, ...written.map((file) => file.version)]),
            ],
            destructiveMigrationVersions: plan.destructive
              ? [...new Set([...previousDestructive, ...written.map((file) => file.version)])]
              : previousDestructive,
          };
          yield* state.writeCheckpoint(checkpoint);
          const journal = yield* state.readJournal;
          if (journal._tag === "Some") {
            yield* state.writeJournal({
              ...journal.value,
              generated: true,
              declarativelyAhead: false,
            });
          }

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
