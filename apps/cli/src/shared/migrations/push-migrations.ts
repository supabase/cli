import { Effect } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { authorizeMutation } from "../database/destructive-auth.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { assertDeclarationsNotAhead } from "../schema/declarations-ahead.ts";
import { SchemaRemoteDriftError } from "../schema/schema-errors.ts";
import { SchemaStateStore } from "../schema/schema-state.service.ts";
import type { SchemaCommandResult } from "../schema/schema-types.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import { MigrationRepository } from "./migration-repository.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";

export type PushMigrationsInput = {
  readonly yes: boolean;
  readonly allowDataLoss: boolean;
  readonly projectRef?: string;
  readonly allowRemote: boolean;
  readonly dbUrl?: string;
};

export const pushMigrations = Effect.fn("migrations.push")(function* (input: PushMigrationsInput) {
  const targets = yield* DatabaseTargetResolver;
  const repository = yield* MigrationRepository;
  const runner = yield* MigrationRunner;
  const engine = yield* PgDeltaSchemaEngine;
  const state = yield* SchemaStateStore;

  yield* assertDeclarationsNotAhead();

  const remote = yield* targets.resolve(
    input.dbUrl !== undefined ? { kind: "url", url: input.dbUrl } : { kind: "linked" },
  );
  const localFiles = yield* repository.listLocal;
  const checkpoint = yield* state.readCheckpoint;
  const generated = new Set(
    checkpoint._tag === "Some" ? (checkpoint.value.generatedMigrationVersions ?? []) : [],
  );
  const destructiveVersions = new Set(
    checkpoint._tag === "Some" ? (checkpoint.value.destructiveMigrationVersions ?? []) : [],
  );

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const remotePool = yield* acquireDatabasePool(remote.connectionString);
      const remoteHistory = yield* runner.listRemote(remotePool);
      const remoteVersions = new Set(remoteHistory.map((row) => row.version));
      const pending = localFiles.filter((file) => !remoteVersions.has(file.version));
      const unclassified = pending.some((file) => !generated.has(file.version));
      const pendingDestructive = pending.some((file) => destructiveVersions.has(file.version));
      const destructive = unclassified || pendingDestructive;

      yield* authorizeMutation({
        target: remote,
        destructive,
        flags: {
          yes: input.yes,
          allowDataLoss: input.allowDataLoss,
          allowRemote: input.allowRemote,
          ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
        },
        command: "migrations push",
      });

      const localTarget = yield* targets.resolve({ kind: "local" }).pipe(Effect.option);
      if (localTarget._tag === "Some") {
        const shadow = yield* engine.provisionShadow;
        const sourcePool = yield* acquireDatabasePool(shadow.url);
        const replayed = localFiles.filter((file) => remoteVersions.has(file.version));
        yield* runner.applyPending(sourcePool, replayed);
        const drift = yield* engine.diffPools({
          sourcePool,
          desiredPool: remotePool,
          allowDrops: true,
        });
        if (drift.changes) {
          return yield* new SchemaRemoteDriftError({
            detail: "Remote database shape has drifted from migration replay.",
            suggestion: "Run `supabase migrations pull` and reconcile before pushing.",
          });
        }
      }

      const result = yield* runner.applyPending(remotePool, localFiles);
      return {
        status: "clean",
        message:
          result.applied.length === 0
            ? "Remote database is up to date."
            : `Pushed ${result.applied.length} migration(s) to ${remote.identity}.`,
        data: {
          status: "clean",
          target: remote.identity,
          applied: result.applied,
          skipped: result.skipped,
          mutated_database: result.applied.length > 0,
          mutated_files: false,
          next_actions: [],
        },
        nextActions: [],
        mutatedDatabase: result.applied.length > 0,
        mutatedFiles: false,
      } satisfies SchemaCommandResult;
    }),
  );
});
