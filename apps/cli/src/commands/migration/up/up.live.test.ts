import { queryMigrationDb } from "../../../../tests/helpers/migration-live.ts";

import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, FileSystem, Path, Predicate } from "effect";
import { expect } from "vitest";

import {
  liveMigrationVersion,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("applies a test-written migration to the remote database", ({
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

      // The serial suite shares one project; seed a stub for every version already in remote
      // history, or `migration up` rejects it as missing locally.
      const remoteVersions = yield* queryMigrationDb<{ version: string }>(
        project.dbUrl,
        "select version from supabase_migrations.schema_migrations order by version",
      ).pipe(
        Effect.catch((error) =>
          // 42P01 = undefined relation, i.e. a fresh project without the migrations table yet.
          Predicate.hasProperty(error.cause, "code") && error.cause.code === "42P01"
            ? Effect.succeed<ReadonlyArray<{ version: string }>>([])
            : Effect.fail(error),
        ),
      );
      for (const row of remoteVersions) {
        yield* fs.writeFileString(
          path.join(migrations, `${row.version}_preexisting_remote.sql`),
          "-- stub for a version already in remote history\n",
        );
      }

      const migrationFile = path.join(migrations, `${version}_e2e_up.sql`);
      yield* fs.writeFileString(
        migrationFile,
        `create table if not exists e2e_up_${version} (id int);\n`,
      );

      const target = Effect.gen(function* () {
        const applied = yield* cliEffect(["migration", "up", "--db-url", project.dbUrl]);
        expect(applied.exitCode, applied.stderr).toBe(0);
        expect(applied.stderr, applied.stdout).toContain("Applying migration");

        const history = yield* queryMigrationDb(
          project.dbUrl,
          "select version from supabase_migrations.schema_migrations where version = $1",
          [version],
        );
        expect(history).toHaveLength(1);

        const created = yield* queryMigrationDb(
          project.dbUrl,
          "select to_regclass($1) as table_oid",
          [`public.e2e_up_${version}`],
        );
        expect(
          created[0]?.["table_oid"],
          "migration up must execute the migration sql",
        ).not.toBeNull();
      });

      const dropTable = Effect.gen(function* () {
        const dropped = yield* cliEffect([
          "db",
          "query",
          `drop table if exists e2e_up_${version}`,
          "--db-url",
          project.dbUrl,
        ]);
        requireLiveSuccess(dropped, "db query cleanup after migration up");
      });

      const revertHistory = Effect.gen(function* () {
        const reverted = yield* cliEffect([
          "migration",
          "repair",
          version,
          "--status",
          "reverted",
          "--db-url",
          project.dbUrl,
        ]);
        requireLiveSuccess(reverted, "migration repair cleanup after migration up");
      });

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const targetExit = yield* Effect.exit(restore(target));
          const cleanupExits: ReadonlyArray<Exit.Exit<unknown, unknown>> = [
            yield* Effect.exit(fs.remove(migrationFile, { force: true })),
            yield* Effect.exit(dropTable),
            yield* Effect.exit(revertHistory),
          ];
          return {
            targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
            cleanupErrors: cleanupExits
              .filter(Exit.isFailure)
              .map((exit) => Cause.squash(exit.cause)),
          };
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    { signal },
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
