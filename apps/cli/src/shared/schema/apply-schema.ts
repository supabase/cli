import { Effect } from "effect";
import { readExportManifest } from "@supabase/pg-delta/frontends";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { applyLocalPending } from "../migrations/apply-local-pending.ts";
import { MigrationRepository } from "../migrations/migration-repository.service.ts";
import type { MigrationApplyResult } from "../migrations/migration-runner.service.ts";
import { digestUtf8, digestVersions } from "./schema-digest.ts";
import {
  SchemaDraftConflictError,
  SchemaDurableTargetError,
  SchemaPartialApplyError,
  SchemaWorkspaceIoError,
} from "./schema-errors.ts";
import { formatNextAction, formatShadowLoadAssist, withPlanSummary } from "./schema-output.ts";
import { assertPlanActionable } from "./schema-plan-gate.ts";
import { SchemaStateStore } from "./schema-state.service.ts";
import type { SchemaCommandResult, SchemaDraftJournal } from "./schema-types.ts";
import { SchemaWorkspace } from "./schema-workspace.service.ts";
import { PgDeltaSchemaEngine } from "./pg-delta-engine.service.ts";

export const applySchema = Effect.fn("schema.apply")(function* () {
  const workspace = yield* SchemaWorkspace;
  const state = yield* SchemaStateStore;
  const engine = yield* PgDeltaSchemaEngine;
  const targets = yield* DatabaseTargetResolver;
  const migrations = yield* MigrationRepository;

  const target = yield* targets.resolve({ kind: "local" });
  if (!target.disposable) {
    return yield* new SchemaDurableTargetError({
      detail: "schema apply can only mutate a verified local disposable database.",
      suggestion:
        "Start the local stack and rerun, or use schema generate + migrations push for durable targets.",
    });
  }

  const declarations = yield* workspace.readDeclarationFiles;
  const localMigrations = yield* migrations.listLocal;

  return yield* state.withLock(
    Effect.scoped(
      Effect.gen(function* () {
        const pool = yield* acquireDatabasePool(target.connectionString);
        const existingJournal = yield* state.readJournal;
        const ungeneratedDraft =
          existingJournal._tag === "Some" &&
          existingJournal.value.declarativelyAhead &&
          existingJournal.value.generated !== true;
        const pendingResult: MigrationApplyResult =
          ungeneratedDraft === true
            ? { applied: [], recorded: [], skipped: [] }
            : yield* applyLocalPending(pool, localMigrations);
        if (ungeneratedDraft) {
          const currentHead = digestVersions(localMigrations.map((file) => file.version));
          if (currentHead !== existingJournal.value.startingMigrationHeadDigest) {
            return yield* new SchemaDraftConflictError({
              detail: "Migration files changed while a declarative draft is active.",
              suggestion:
                "Run `supabase schema generate`, reset the local database, or discard the draft.",
            });
          }
        }

        const shadow = yield* engine.provisionShadow;
        const shadowPool = yield* acquireDatabasePool(shadow.url);
        const manifest = yield* Effect.try({
          try: () => readExportManifest(workspace.schemasDir),
          catch: (cause) =>
            new SchemaWorkspaceIoError({
              detail: cause instanceof Error ? cause.message : String(cause),
              suggestion: "Fix supabase/schemas/.pgdelta-export.json or remove it and retry.",
            }),
        });
        const plan = yield* engine.planFiles({
          targetPool: pool,
          shadowPool,
          files: declarations,
          allowDrops: true,
          ...(manifest !== undefined ? { manifest } : {}),
        });

        yield* assertPlanActionable(plan);

        if (!plan.changes) {
          const recorded = pendingResult.recorded ?? [];
          const mutatedDatabase = pendingResult.applied.length > 0 || recorded.length > 0;
          const parts = [
            ...(recorded.length > 0
              ? [`Recorded ${recorded.length} already-applied migration(s): ${recorded.join(", ")}`]
              : []),
            ...(pendingResult.applied.length > 0
              ? [
                  `Applied ${pendingResult.applied.length} migration(s): ${pendingResult.applied.join(", ")}`,
                ]
              : []),
          ];
          const loadAssist = formatShadowLoadAssist(plan);
          const base =
            parts.length > 0 ? parts.join(". ") : "Local database already matches declarations.";
          return {
            status: "clean",
            message: loadAssist.length > 0 ? `${base}\n${loadAssist}` : base,
            data: {
              status: "clean",
              target: target.identity,
              plan_id: plan.planId,
              source_fingerprint: plan.sourceFingerprint,
              desired_fingerprint: plan.desiredFingerprint,
              applied: pendingResult.applied,
              recorded,
              mutated_database: mutatedDatabase,
              mutated_files: false,
            },
            nextActions: [],
            mutatedDatabase,
            mutatedFiles: false,
          } satisfies SchemaCommandResult;
        }

        const outcome = yield* engine.applyPlan({ pool, plan });
        const journal: SchemaDraftJournal = {
          version: 1,
          draftId: crypto.randomUUID(),
          targetIdentity: target.identity,
          startingMigrationHeadDigest: digestVersions(localMigrations.map((file) => file.version)),
          sourceFingerprint: plan.sourceFingerprint,
          engineVersion: plan.engineVersion,
          declarativelyAhead: true,
          generated: false,
          plans: [
            {
              planId: plan.planId,
              targetFingerprint: plan.desiredFingerprint,
              acceptedRenames: plan.acceptedRenames,
              segmentDigests: plan.files.map((file) => digestUtf8(file.sql)),
              hazards: {
                kinds: plan.hazards.kinds,
                destructive: plan.hazards.destructive,
                rewrite: plan.hazards.rewrite,
                coverageGaps: plan.hazards.coverageGaps,
              },
              actionStatuses: outcome.report.actionStatuses,
              outcome: outcome.partial ? "partial" : "applied",
            },
          ],
        };
        yield* state.writeJournal(journal);

        if (outcome.partial) {
          const failed = outcome.report.error;
          return yield* new SchemaPartialApplyError({
            detail:
              failed === undefined
                ? "Could not apply schema changes to the local database."
                : `Could not apply schema changes to the local database.\n${failed.message}\n${failed.sql}`,
            suggestion:
              "The local database may be only partly updated. Run `supabase db reset`, fix the failing change in supabase/schemas, then retry `supabase schema apply`.",
          });
        }

        const nextActions = [
          formatNextAction("to generate a migration", "supabase schema generate --name <feature>"),
        ];

        return {
          status: "draft",
          message: withPlanSummary(
            "Applied locally and journaled. No migration files were written.",
            plan,
          ),
          data: {
            status: "draft",
            plan_id: plan.planId,
            source_fingerprint: plan.sourceFingerprint,
            desired_fingerprint: plan.desiredFingerprint,
            hazards: plan.hazards,
            target: target.identity,
            journaled: true,
            mutated_database: true,
            mutated_files: false,
            next_actions: nextActions,
          },
          nextActions,
          mutatedDatabase: true,
          mutatedFiles: false,
        } satisfies SchemaCommandResult;
      }),
    ),
  );
});
