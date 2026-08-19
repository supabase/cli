import { Effect } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { authorizeMutation } from "../database/destructive-auth.ts";
import { MigrationRepository } from "../migrations/migration-repository.service.ts";
import { MigrationRunner } from "../migrations/migration-runner.service.ts";
import { digestUtf8, digestVersions } from "./schema-digest.ts";
import {
  SchemaDraftConflictError,
  SchemaDurableTargetError,
  SchemaPartialApplyError,
} from "./schema-errors.ts";
import { formatPlanSummary } from "./schema-output.ts";
import { assertPlanActionable } from "./schema-plan-gate.ts";
import { SchemaStateStore } from "./schema-state.service.ts";
import type { SchemaCommandResult, SchemaDraftJournal } from "./schema-types.ts";
import { SchemaWorkspace } from "./schema-workspace.service.ts";
import { PgDeltaSchemaEngine } from "./pg-delta-engine.service.ts";

export type ApplySchemaInput = {
  readonly yes: boolean;
  readonly allowDataLoss: boolean;
  readonly projectRef?: string;
  readonly allowRemote: boolean;
};

export const applySchema = Effect.fn("schema.apply")(function* (input: ApplySchemaInput) {
  const workspace = yield* SchemaWorkspace;
  const state = yield* SchemaStateStore;
  const engine = yield* PgDeltaSchemaEngine;
  const targets = yield* DatabaseTargetResolver;
  const migrations = yield* MigrationRepository;
  const runner = yield* MigrationRunner;

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
        if (
          existingJournal._tag === "Some" &&
          existingJournal.value.declarativelyAhead &&
          existingJournal.value.generated !== true
        ) {
          const currentHead = digestVersions(localMigrations.map((file) => file.version));
          if (currentHead !== existingJournal.value.startingMigrationHeadDigest) {
            return yield* new SchemaDraftConflictError({
              detail: "Migration files changed while a declarative draft is active.",
              suggestion:
                "Run `supabase schema generate`, reset the local database, or discard the draft.",
            });
          }
        } else {
          yield* runner.applyPending(pool, localMigrations);
        }

        const shadow = yield* engine.provisionShadow;
        const shadowPool = yield* acquireDatabasePool(shadow.url);
        const plan = yield* engine.planFiles({
          targetPool: pool,
          shadowPool,
          files: declarations,
          allowDrops: true,
        });

        yield* assertPlanActionable(plan);
        yield* authorizeMutation({
          target,
          destructive: plan.destructive,
          flags: {
            yes: true,
            allowDataLoss: true,
            allowRemote: input.allowRemote,
            ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
          },
          command: "schema apply",
        });

        if (!plan.changes) {
          return {
            status: "clean",
            message: "Local database already matches declarations.",
            data: {
              status: "clean",
              target: target.identity,
              plan_id: plan.planId,
              mutated_database: false,
              mutated_files: false,
            },
            nextActions: [],
            mutatedDatabase: false,
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
          return yield* new SchemaPartialApplyError({
            detail: "schema apply stopped after a partial or in-doubt segment.",
            suggestion: "Reset or repair the local database. Do not retry the same plan blindly.",
          });
        }

        const summary = formatPlanSummary({
          title: "Schema apply",
          source: `local@${plan.sourceFingerprint.slice(0, 8)}`,
          desired: `declarations@${plan.desiredFingerprint.slice(0, 8)}`,
          target: target.identity,
          plan,
        });

        return {
          status: "draft",
          message: `${summary}\nResult: applied locally and journaled. No migration files were written.`,
          data: {
            status: "draft",
            plan_id: plan.planId,
            hazards: plan.hazards,
            target: target.identity,
            journaled: true,
            mutated_database: true,
            mutated_files: false,
            next_actions: ["Run tests, then supabase schema generate --name <feature>"],
          },
          nextActions: ["Run tests, then supabase schema generate --name <feature>"],
          mutatedDatabase: true,
          mutatedFiles: false,
        } satisfies SchemaCommandResult;
      }),
    ),
  );
});
