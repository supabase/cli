import { BunServices } from "@effect/platform-bun";
import { Cause, Clock, Effect, Exit, FileSystem, Path, Random } from "effect";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";

test("pushes a local migration to the remote database", ({
  cliEffect,
  project,
  workspace,
  signal,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const millis = yield* Clock.currentTimeMillis;
      const suffix = yield* Random.nextIntBetween(0, 10_000, { halfOpen: true });
      const version = `${millis}${suffix.toString().padStart(4, "0")}`;
      const migrations = path.join(workspace.path, "supabase", "migrations");
      yield* fs.makeDirectory(migrations, { recursive: true });
      const migrationFile = path.join(migrations, `${version}_e2e_push.sql`);
      yield* fs.writeFileString(
        migrationFile,
        `create table if not exists e2e_push_${version} (id int);\n`,
      );

      const target = Effect.gen(function* () {
        const result = yield* cliEffect(["db", "push", "--db-url", project.dbUrl, "--yes"]);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout).toContain("Finished supabase db push");
      });

      const reset = Effect.gen(function* () {
        const result = yield* cliEffect(["db", "reset", "--db-url", project.dbUrl, "--yes"]);
        requireLiveSuccess(result, "db reset cleanup after db push");
      });

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const targetExit = yield* Effect.exit(restore(target));
          const cleanupExits: ReadonlyArray<Exit.Exit<unknown, unknown>> = [
            yield* Effect.exit(fs.remove(migrationFile)),
            yield* Effect.exit(reset),
          ];
          return {
            targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
            cleanupErrors: cleanupExits
              .filter(Exit.isFailure)
              .map((exit) => Cause.squash(exit.cause)),
          };
        }),
      );
    }).pipe(Effect.provide(BunServices.layer)),
    { signal },
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
