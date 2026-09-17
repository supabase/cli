import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, FileSystem, Path } from "effect";
import { expect } from "vitest";

import {
  liveMigrationVersion,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";
import { MigrationLiveError } from "../../../../tests/helpers/migration-live.ts";

const LIVE_TIMEOUT_MS = 120_000;

const NAME = "cli_live_fetch";

// Destructive: repairs remote migration history in setup and reverts that row in
// teardown.
//
// `fetch` has no undefined-table fallback (unlike `list`), so it fails against a fresh
// project with no schema_migrations table. The setup seeds one row via
// `migration repair --status applied` first, which creates the table. The pooler URL
// is passed explicitly to avoid falling back to a direct IPv6 host.
test(
  "fetches a seeded remote migration into the local migrations directory",
  { timeout: LIVE_TIMEOUT_MS },
  ({ cliEffect, project, signal }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const targetArgs = ["--db-url", project.dbUrl];
        const version = liveMigrationVersion();
        const migrationFile = `${version}_${NAME}.sql`;
        const seedDir = yield* fs.makeTempDirectoryScoped({ prefix: "sb-migration-seed-live-" });
        const fetchDir = yield* fs.makeTempDirectoryScoped({ prefix: "sb-migration-fetch-live-" });

        const target = Effect.gen(function* () {
          // repair --status applied reads the local file for name/statements, so write it
          // before running repair.
          yield* fs.makeDirectory(path.join(seedDir, "supabase", "migrations"), {
            recursive: true,
          });
          yield* fs.writeFileString(
            path.join(seedDir, "supabase", "migrations", migrationFile),
            "create table if not exists public.cli_live_roundtrip (id int);\n",
          );
          const repairResult = yield* cliEffect(
            ["migration", "repair", version, "--status", "applied", ...targetArgs],
            { cwd: seedDir },
          );
          requireLiveSuccess(repairResult, "migration repair setup");

          // A fresh, empty dir avoids the overwrite prompt.
          const fetched = yield* cliEffect(["migration", "fetch", ...targetArgs], {
            cwd: fetchDir,
          });
          expect(fetched.exitCode, `stdout:\n${fetched.stdout}\nstderr:\n${fetched.stderr}`).toBe(
            0,
          );

          const files = yield* fs.readDirectory(path.join(fetchDir, "supabase", "migrations"));
          expect(files).toContain(migrationFile);
        });

        const revert = Effect.gen(function* () {
          const reverted = yield* cliEffect(
            ["migration", "repair", version, "--status", "reverted", ...targetArgs],
            { cwd: seedDir },
          );
          if (
            reverted.exitCode !== 0 &&
            !/not found|does not exist/i.test(`${reverted.stdout}\n${reverted.stderr}`)
          ) {
            return yield* new MigrationLiveError({
              message: `migration repair cleanup failed:\n${reverted.stdout}\n${reverted.stderr}`,
            });
          }
        });

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const targetExit = yield* Effect.exit(restore(target));
            const cleanupExits: ReadonlyArray<Exit.Exit<unknown, unknown>> = [
              yield* Effect.exit(revert),
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
    ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)),
);
