import { removeMigration } from "../../../../tests/helpers/migration-live.ts";

import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, FileSystem, Path } from "effect";
import { expect } from "vitest";

import {
  liveMigrationVersion,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("lists a seeded remote migration", ({ cli, cliEffect, project, signal }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetArgs = ["--db-url", project.dbUrl];
      const version = liveMigrationVersion();
      // Seeded outside the workspace so the version can only reach stdout through the remote column.
      const seedDir = yield* fs.makeTempDirectoryScoped({ prefix: "sb-migration-list-live-" });

      const target = Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(seedDir, "supabase", "migrations"), { recursive: true });
        yield* fs.writeFileString(
          path.join(seedDir, "supabase", "migrations", `${version}_cli_live_list.sql`),
          "select 1;\n",
        );
        const seeded = yield* cliEffect(
          ["migration", "repair", version, "--status", "applied", ...targetArgs],
          { cwd: seedDir },
        );
        requireLiveSuccess(seeded, "migration repair setup");

        const result = yield* cliEffect(["migration", "list", ...targetArgs]);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout, result.stderr).toContain(version);
      });

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const targetExit = yield* Effect.exit(restore(target));
          const cleanupExits: ReadonlyArray<Exit.Exit<unknown, unknown>> = [
            yield* Effect.exit(removeMigration(cli, project, version)),
            yield* Effect.exit(fs.remove(seedDir, { recursive: true, force: true })),
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
