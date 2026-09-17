import { queryMigrationDb } from "../../../../tests/helpers/migration-live.ts";

import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, FileSystem, Path } from "effect";
import { expect } from "vitest";

import {
  liveMigrationVersion,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("amends the migration history status on the remote database", ({
  cliEffect,
  project,
  workspace,
  signal,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const version = liveMigrationVersion();
      const migrations = path.join(workspace.path, "supabase", "migrations");
      yield* fs.makeDirectory(migrations, { recursive: true });
      const migrationFile = path.join(migrations, `${version}_e2e_repair.sql`);
      // `repair --status applied` records the file's statements in migration
      // history without executing them, so this table is never actually created.
      yield* fs.writeFileString(
        migrationFile,
        `create table if not exists e2e_repair_${version} (id int);\n`,
      );

      let versionReverted = false;
      const target = Effect.gen(function* () {
        const applied = yield* cliEffect([
          "migration",
          "repair",
          version,
          "--status",
          "applied",
          "--db-url",
          project.dbUrl,
        ]);
        expect(applied.exitCode, applied.stderr).toBe(0);
        expect(applied.stderr, applied.stdout).toContain("=> applied");
        yield* fs.remove(migrationFile);

        const recorded = yield* queryMigrationDb(
          project.dbUrl,
          "select version from supabase_migrations.schema_migrations where version = $1",
          [version],
        );
        expect(recorded).toHaveLength(1);

        const reverted = yield* cliEffect([
          "migration",
          "repair",
          version,
          "--status",
          "reverted",
          "--db-url",
          project.dbUrl,
        ]);
        expect(reverted.exitCode, reverted.stderr).toBe(0);
        expect(reverted.stderr, reverted.stdout).toContain("=> reverted");

        const remaining = yield* queryMigrationDb(
          project.dbUrl,
          "select version from supabase_migrations.schema_migrations where version = $1",
          [version],
        );
        expect(remaining).toHaveLength(0);
        // Only skip the teardown revert once the row is verifiably gone.
        versionReverted = true;
      });

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const targetExit = yield* Effect.exit(restore(target));
          const cleanupExit = yield* Effect.exit(
            Effect.suspend(() =>
              versionReverted
                ? Effect.void
                : Effect.gen(function* () {
                    const cleanup = yield* cliEffect([
                      "migration",
                      "repair",
                      version,
                      "--status",
                      "reverted",
                      "--db-url",
                      project.dbUrl,
                    ]);
                    requireLiveSuccess(cleanup, "migration repair cleanup");
                  }),
            ),
          );
          return {
            targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
            cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
          };
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    { signal },
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
