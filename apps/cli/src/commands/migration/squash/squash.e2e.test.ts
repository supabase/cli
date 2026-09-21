import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect, stripAnsi } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

const makeWorkdir = Effect.fnUntraced(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workdir = yield* fs.makeTempDirectoryScoped({ prefix });
  yield* fs.makeDirectory(path.join(workdir, "supabase", "migrations"), { recursive: true });
  yield* fs.writeFileString(path.join(workdir, "supabase", "config.toml"), "[db]\nport = 54322\n");
  return workdir;
});

describe("supabase migration squash", () => {
  // Exercises the real migrationSquashRuntimeLayer end to end without touching
  // Docker/Postgres. This is a validation error, not a cancellation, so the usual
  // --debug hint still follows it.
  it.live(
    "rejects a non-numeric --version with the bare Go message",
    () =>
      Effect.gen(function* () {
        const workdir = yield* makeWorkdir("sb-mig-squash-version-e2e-");

        const { exitCode, stderr } = yield* runSupabaseEffect(
          ["migration", "squash", "--version", "0_init"],
          { cwd: workdir },
        );

        expect(exitCode).toBe(1);
        const text = stripAnsi(stderr);
        expect(text).toContain("invalid version number");
        expect(text).not.toContain("failed to parse");
        expect(text).toContain("Try rerunning the command with --debug to troubleshoot the error.");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );

  // A single local migration short-circuits squashToVersion before any
  // shadow-database work, exercising the local no-op + suggestion path end to end.
  it.live(
    "no-ops on a single local migration and suggests migration repair",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir("sb-mig-squash-noop-e2e-");
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "migrations", "20240101000000_init.sql"),
          "select 1;\n",
        );

        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["migration", "squash", "--local"],
          { cwd: workdir },
        );

        expect(exitCode).toBe(0);
        expect(stripAnsi(stderr)).toContain(
          "supabase/migrations/20240101000000_init.sql is already the earliest migration.",
        );
        expect(stripAnsi(stdout)).toContain("Finished supabase migration squash.");
        expect(stripAnsi(stderr)).toContain(
          "Run supabase migration repair --status applied to update your remote migration history table.",
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );
});
