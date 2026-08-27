import { Clock, Effect } from "effect";
import { readExportManifest } from "@supabase/pg-delta/frontends";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import {
  classifyPrivilegePlan,
  PRIVILEGE_REFRESH_SUGGESTION,
} from "../migrations/privilege-offer.ts";
import { MigrationRepository } from "../migrations/migration-repository.service.ts";
import { MigrationRunner } from "../migrations/migration-runner.service.ts";
import { formatMigrationRepairCommand } from "../migrations/migration-repair-suggest.ts";
import {
  generateLocalShadowBanner,
  readConfigPostgresMajor,
} from "../migrations/remote-postgres.ts";
import { formatPlanSql } from "./schema-body.ts";
import { digestVersions } from "./schema-digest.ts";
import {
  SchemaBaselineMigrationsExistError,
  SchemaDraftConflictError,
  SchemaEngineError,
  SchemaLinkedConnectionError,
  SchemaTargetRequiredError,
  SchemaWorkspaceIoError,
} from "./schema-errors.ts";
import { formatMigrationFilePath, formatNextAction, withPlanSummary } from "./schema-output.ts";
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

  const declarations = yield* workspace.readDeclarationFiles;
  const localMigrations = yield* migrations.listLocal;
  const name = input.name ?? (input.baseline ? "initial_schema" : "schema");
  const nextName = input.name ?? (input.baseline ? "initial_schema" : "<feature>");
  const banner = generateLocalShadowBanner(yield* readConfigPostgresMajor());

  if (input.baseline && localMigrations.length > 0) {
    return yield* new SchemaBaselineMigrationsExistError({
      detail: `--baseline cannot run because ${workspace.migrationsDirDisplay} already has files.`,
      suggestion:
        "supabase schema generate --dry-run to preview, or supabase schema generate --name <feature> to add a change. --baseline is only for empty migration history.",
    });
  }

  if (input.baseline) {
    const targets = yield* DatabaseTargetResolver;
    const runner = yield* MigrationRunner;
    const linked = yield* targets.resolve({ kind: "linked" }).pipe(
      Effect.catchIf(
        (error): error is SchemaLinkedConnectionError | SchemaTargetRequiredError =>
          error._tag === "SchemaLinkedConnectionError" ||
          error._tag === "SchemaTargetRequiredError",
        () => Effect.succeed(undefined),
      ),
    );
    if (linked !== undefined) {
      const remoteHistory = yield* Effect.scoped(
        Effect.gen(function* () {
          const pool = yield* acquireDatabasePool(linked.connectionString);
          return yield* runner.listRemote(pool);
        }),
      );
      if (remoteHistory.length > 0) {
        return yield* new SchemaBaselineMigrationsExistError({
          detail: `--baseline cannot run because the linked database already has migration history.`,
          suggestion:
            "Remote has migration history. Run supabase migrations pull --from linked, then supabase schema pull --from linked.",
        });
      }
    }
  }

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

        const sourceShadow = input.baseline
          ? yield* engine.provisionShadow
          : yield* engine.provisionMigrations;
        const desiredShadow = yield* engine.provisionShadow;

        const sourcePool = yield* acquireDatabasePool(sourceShadow.url);
        const desiredPool = yield* acquireDatabasePool(desiredShadow.url);

        const manifest = yield* Effect.try({
          try: () => readExportManifest(workspace.schemasDir),
          catch: (cause) =>
            new SchemaWorkspaceIoError({
              detail: cause instanceof Error ? cause.message : String(cause),
              suggestion: "Fix supabase/schemas/.pgdelta-export.json or remove it and retry.",
            }),
        });
        const plan = yield* engine.planFiles({
          targetPool: sourcePool,
          shadowPool: desiredPool,
          files: declarations,
          allowDrops: true,
          ...(manifest !== undefined ? { manifest } : {}),
        });

        if (!input.dryRun) {
          yield* assertPlanActionable(plan);
        }

        if (input.dryRun || !plan.changes) {
          if (!input.dryRun && !plan.changes) {
            yield* state.clearJournal;
          }
          const nextActions = plan.changes
            ? [
                formatNextAction(
                  "to write the migration",
                  `supabase schema generate --name ${nextName}`,
                ),
              ]
            : [];
          const sql = formatPlanSql(plan);
          const statusLine = plan.changes
            ? "Dry-run; nothing was written."
            : "Declarations already match migration replay.";
          return {
            status: plan.changes ? "needs_approval" : "clean",
            message: `${withPlanSummary(statusLine, plan)}\n${banner}`,
            ...(plan.changes && sql.length > 0 ? { body: sql } : {}),
            data: {
              status: plan.changes ? "needs_approval" : "clean",
              plan_id: plan.planId,
              source_fingerprint: plan.sourceFingerprint,
              desired_fingerprint: plan.desiredFingerprint,
              hazards: plan.hazards,
              files_written: [],
              sql,
              files: plan.files,
              mutated_database: false,
              mutated_files: false,
              next_actions: nextActions,
            },
            nextActions,
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
          const verifyShadow = yield* engine.provisionMigrations;
          const verifySource = yield* acquireDatabasePool(verifyShadow.url);
          const verifyDesired = yield* engine.provisionShadow;
          const verifyDesiredPool = yield* acquireDatabasePool(verifyDesired.url);
          const verify = yield* engine.planFiles({
            targetPool: verifySource,
            shadowPool: verifyDesiredPool,
            files: declarations,
            allowDrops: true,
            ...(manifest !== undefined ? { manifest } : {}),
          });
          if (verify.changes) {
            const aheadKind = yield* classifyPrivilegePlan(verify);
            return yield* new SchemaEngineError({
              detail:
                aheadKind === "not_acl"
                  ? "Generated migrations did not converge to the declared schema."
                  : "Generated migrations differ from declarations by privileges only.",
              suggestion:
                aheadKind === "not_acl"
                  ? "Inspect the generated files and rerun schema generate."
                  : PRIVILEGE_REFRESH_SUGGESTION,
            });
          }

          yield* state.clearJournal;

          const nextActions = input.baseline
            ? [
                formatNextAction(
                  "to record it as applied",
                  formatMigrationRepairCommand({
                    status: "applied",
                    versions: written.map((file) => file.version),
                  }),
                ),
              ]
            : [formatNextAction("to deploy", "supabase migrations push")];

          return {
            status: "generated",
            message: `${withPlanSummary(
              `Wrote ${written.map((file) => formatMigrationFilePath(file.fileName)).join(", ")}`,
              plan,
            )}\n${banner}`,
            data: {
              status: "generated",
              plan_id: plan.planId,
              source_fingerprint: plan.sourceFingerprint,
              desired_fingerprint: plan.desiredFingerprint,
              hazards: plan.hazards,
              files_written: written.map((file) => file.fileName),
              sql: formatPlanSql(plan),
              files: plan.files,
              mutated_database: false,
              mutated_files: true,
              next_actions: nextActions,
            },
            nextActions,
            mutatedDatabase: false,
            mutatedFiles: true,
          } satisfies SchemaCommandResult;
        });

        return yield* persistGenerated.pipe(Effect.tapError(() => migrations.remove(written)));
      }),
    ),
  );
});
