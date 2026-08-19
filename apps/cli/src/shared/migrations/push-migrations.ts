import { Effect } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { authorizeMutation } from "../database/destructive-auth.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { assertNoUngeneratedDraft } from "../schema/declarations-ahead.ts";
import { SchemaDeclarationsAheadError, SchemaRemoteDriftError } from "../schema/schema-errors.ts";
import type { SchemaCommandResult } from "../schema/schema-types.ts";
import { SchemaWorkspace } from "../schema/schema-workspace.service.ts";
import { PgDeltaSchemaEngine } from "../schema/pg-delta-engine.service.ts";
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
          const sourceShadow = yield* engine.provisionShadow;
          const desiredShadow = yield* engine.provisionShadow;
          const sourcePool = yield* acquireDatabasePool(sourceShadow.url);
          const desiredPool = yield* acquireDatabasePool(desiredShadow.url);
          yield* runner.applyPending(sourcePool, localFiles);
          const ahead = yield* engine.planFiles({
            targetPool: sourcePool,
            shadowPool: desiredPool,
            files: declarations,
            allowDrops: true,
          });
          if (ahead.changes) {
            return yield* new SchemaDeclarationsAheadError({
              detail: "Declarations are ahead of the local migration files.",
              suggestion:
                "Run `supabase schema generate --name <feature>` before `supabase migrations push`.",
            });
          }
        }

        const driftShadow = yield* engine.provisionShadow;
        const replayPool = yield* acquireDatabasePool(driftShadow.url);
        const replayed = localFiles.filter((file) => remoteVersions.has(file.version));
        yield* runner.applyPending(replayPool, replayed);
        const drift = yield* engine.diffPools({
          sourcePool: replayPool,
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
