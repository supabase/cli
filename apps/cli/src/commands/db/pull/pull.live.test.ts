import { randomUUID } from "node:crypto";

import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, FileSystem, Path } from "effect";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";

// `db pull` exits non-zero on an empty diff (the in-sync finding), so this seeds a
// remote-only marker table via `db query` with no local migration/history row — the
// marker can't exist in the fresh shadow, so the diff is never empty.
test("pulls the remote schema into an initial migration", ({
  cliEffect,
  project,
  workspace,
  signal,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const marker = `e2e_pull_${randomUUID().slice(0, 8)}`;
      const migrations = path.join(workspace.path, "supabase", "migrations");
      yield* fs.makeDirectory(migrations, { recursive: true });
      const existingMigrations = new Set(yield* fs.readDirectory(migrations));

      const target = Effect.gen(function* () {
        const seeded = yield* cliEffect([
          "db",
          "query",
          `create table if not exists ${marker} (id int)`,
          "--db-url",
          project.dbUrl,
        ]);
        requireLiveSuccess(seeded, "db query setup for db pull");

        const result = yield* cliEffect(["db", "pull", "--db-url", project.dbUrl, "--yes"]);
        expect(result.exitCode, result.stderr).toBe(0);

        expect(result.stderr, result.stderr).toContain("Schema written to");
        const generated = (yield* fs.readDirectory(migrations)).filter(
          (file) => !existingMigrations.has(file),
        );
        expect(generated.length, result.stderr).toBeGreaterThan(0);
        const pulled = yield* Effect.forEach(
          generated,
          (file) => fs.readFileString(path.join(migrations, file)),
          { concurrency: "unbounded" },
        );
        expect(pulled.join("\n"), result.stderr).toContain(marker);
      });

      const resetRemote = Effect.gen(function* () {
        const reset = yield* cliEffect(["db", "reset", "--db-url", project.dbUrl, "--yes"]);
        requireLiveSuccess(reset, "db reset cleanup after db pull");
      });

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const targetExit = yield* Effect.exit(restore(target));
          const cleanupExits: Array<Exit.Exit<unknown, unknown>> = [];
          // Remove the generated migration before resetting so the reset replays an
          // empty local set and restores the baseline schema, dropping the marker.
          const listed = yield* Effect.exit(fs.readDirectory(migrations));
          cleanupExits.push(listed);
          const currentMigrations = Exit.isSuccess(listed) ? listed.value : [];
          for (const file of currentMigrations.filter(
            (candidate) => !existingMigrations.has(candidate),
          )) {
            cleanupExits.push(yield* Effect.exit(fs.remove(path.join(migrations, file))));
          }
          cleanupExits.push(yield* Effect.exit(resetRemote));
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
