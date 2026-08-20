import { Effect } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { authorizeMutation } from "../database/destructive-auth.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { assertNoUngeneratedDraft } from "../schema/declarations-ahead.ts";
import {
  SchemaDeclarationsAheadError,
  SchemaHistoryConflictError,
  SchemaRemoteDriftError,
} from "../schema/schema-errors.ts";
import type { SchemaCommandResult } from "../schema/schema-types.ts";
import { SchemaWorkspace } from "../schema/schema-workspace.service.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
import { findMatchingPendingPrefix } from "./matching-pending-prefix.ts";
import {
  formatHistoryConflict,
  repairFlagsForTarget,
  suggestRemoteDriftRepair,
} from "./migration-repair-suggest.ts";
import { MigrationRepository } from "./migration-repository.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";

export type PushMigrationsInput = {
  readonly yes: boolean;
  readonly projectRef?: string;
  readonly allowRemote: boolean;
  readonly dbUrl?: string;
  readonly skipVerify: boolean;
};

export const pushMigrations = Effect.fn("migrations.push")(function* (input: PushMigrationsInput) {
  const targets = yield* DatabaseTargetResolver;
  const repository = yield* MigrationRepository;
  const runner = yield* MigrationRunner;
  const engine = yield* PgDeltaSchemaEngine;
  const workspace = yield* SchemaWorkspace;

  yield* assertNoUngeneratedDraft();

  const remote = yield* targets.resolve(
    input.dbUrl !== undefined ? { kind: "url", url: input.dbUrl } : { kind: "linked" },
  );
  const localFiles = yield* repository.listLocal;
  const declarations = yield* workspace.readDeclarationFiles;

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const remotePool = yield* acquireDatabasePool(remote.connectionString);
      const remoteHistory = yield* runner.listRemote(remotePool);
      const remoteVersions = new Set(remoteHistory.map((row) => row.version));

      yield* authorizeMutation({
        target: remote,
        flags: {
          yes: input.yes,
          allowRemote: input.allowRemote,
          ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
        },
        command: "migrations push",
      });

      if (!input.skipVerify) {
        if (declarations.length > 0) {
          const sourceShadow = yield* engine.provisionMigrations;
          const desiredShadow = yield* engine.provisionShadow;
          const sourcePool = yield* acquireDatabasePool(sourceShadow.url);
          const desiredPool = yield* acquireDatabasePool(desiredShadow.url);
          const ahead = yield* engine.planFiles({
            targetPool: sourcePool,
            shadowPool: desiredPool,
            files: declarations,
            allowDrops: true,
          });
          if (ahead.changes) {
            return yield* new SchemaDeclarationsAheadError({
              detail: "Declarations and local migration files have diverged.",
              suggestion:
                "Update `supabase/schemas` to include hand-written migration changes, or run `supabase schema generate --name <feature>` if declarations are the intended state.",
            });
          }
        }

        const driftShadow = yield* engine.provisionPlatform;
        const replayPool = yield* acquireDatabasePool(driftShadow.url);
        const replayed = localFiles.filter((file) => remoteVersions.has(file.version));
        yield* runner.applyPending(replayPool, replayed);
        const drift = yield* engine.diffPools({
          sourcePool: replayPool,
          desiredPool: remotePool,
          allowDrops: true,
        });
        if (drift.changes) {
          const remoteOnly = remoteHistory
            .filter((row) => !localFiles.some((file) => file.version === row.version))
            .map((row) => row.version);
          const pending = localFiles.filter((file) => !remoteVersions.has(file.version));
          const matchingPrefix = yield* findMatchingPendingPrefix(
            replayPool,
            remotePool,
            replayed,
            pending,
          );
          return yield* new SchemaRemoteDriftError({
            detail: "Remote database shape has drifted from migration replay.",
            suggestion: suggestRemoteDriftRepair({
              remoteOnly,
              matchingPrefix: matchingPrefix.map((file) => file.version),
              flags: repairFlagsForTarget(remote, {
                ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
                ...(input.dbUrl !== undefined ? { dbUrl: input.dbUrl } : {}),
              }),
            }),
          });
        }
      }

      const pending = localFiles.filter((file) => !remoteVersions.has(file.version));
      const remoteOnly = remoteHistory.filter(
        (row) => !localFiles.some((file) => file.version === row.version),
      );
      if (remoteOnly.length > 0 && pending.length > 0) {
        return yield* new SchemaHistoryConflictError(
          formatHistoryConflict({
            remoteOnly: remoteOnly.map((row) => row.version),
            pending: pending.map((file) => file.version),
            flags: repairFlagsForTarget(remote, {
              ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
              ...(input.dbUrl !== undefined ? { dbUrl: input.dbUrl } : {}),
            }),
          }),
        );
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
