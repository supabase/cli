import { BunServices } from "@effect/platform-bun";
import { Cause, Clock, Effect, Exit, FileSystem, Path, Random } from "effect";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";

test("resets the remote database with local migrations", ({
  cliEffect,
  project,
  workspace,
  signal,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const now = yield* Clock.currentTimeMillis;
      const suffix = yield* Random.nextIntBetween(0, 10_000, { halfOpen: true });
      const version = `${now}${suffix.toString().padStart(4, "0")}`;
      const migrations = path.join(workspace.path, "supabase", "migrations");
      yield* fs.makeDirectory(migrations, { recursive: true });
      const migrationFile = path.join(migrations, `${version}_e2e_reset.sql`);
      yield* fs.writeFileString(
        migrationFile,
        `create table if not exists e2e_reset_${version} (id int);\n`,
      );

      const target = Effect.gen(function* () {
        const result = yield* cliEffect(["db", "reset", "--db-url", project.dbUrl, "--yes"]);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain("Resetting remote database");
      });

      const resetCleanup = Effect.gen(function* () {
        const reset = yield* cliEffect(["db", "reset", "--db-url", project.dbUrl, "--yes"]);
        requireLiveSuccess(reset, "db reset cleanup");
      });

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const targetExit = yield* Effect.exit(restore(target));
          const cleanupExits: ReadonlyArray<Exit.Exit<unknown, unknown>> = [
            yield* Effect.exit(fs.remove(migrationFile)),
            yield* Effect.exit(resetCleanup),
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
