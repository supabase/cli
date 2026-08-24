import { BunServices } from "@effect/platform-bun";
import { beforeEach, describe, expect, test } from "vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabase, stripAnsi } from "../../../../../tests/helpers/cli.ts";
import { useLegacyTempWorkdir } from "../../../../../tests/helpers/legacy-mocks.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase migration squash (legacy)", () => {
  const workdir = useLegacyTempWorkdir("sb-mig-squash-e2e-");
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(workdir.current, "supabase", "migrations"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(workdir.current, "supabase", "config.toml"),
          "[db]\nport = 54322\n",
        );
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );

  // Real-subprocess guard for the production layer graph: `--version 0_init` is
  // not a valid integer, so the bare `invalid version number` message
  // (no repair-style `failed to parse <v>:` prefix) must surface — proving the
  // real `legacyMigrationSquashRuntimeLayer` builds end to end, without ever
  // touching Docker/Postgres. This is the same class of missing-service bug the
  // `migration fetch` e2e exists to catch. Unlike a declined confirmation prompt
  // (a genuine cancellation), this is a genuine validation error, so the usual
  // `--debug` troubleshooting hint still follows it (`output.layer.ts`'s
  // `CONTEXT_CANCELED_MESSAGE` guard does not apply here).
  test(
    "rejects a non-numeric --version with the bare Go message",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      runSupabase(["migration", "squash", "--version", "0_init"], {
        entrypoint: "legacy",
        cwd: workdir.current,
      }).then(({ exitCode, stderr }) => {
        expect(exitCode).toBe(1);
        const text = stripAnsi(stderr);
        expect(text).toContain("invalid version number");
        expect(text).not.toContain("failed to parse");
        expect(text).toContain("Try rerunning the command with --debug to troubleshoot the error.");
      }),
  );

  // Golden path with no Docker required: a single local migration short-circuits
  // `squashToVersion` before any shadow-database work, so this proves the whole
  // local no-op + `--local` suggestion path end to end.
  test(
    "no-ops on a single local migration and suggests migration repair",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.writeFileString(
            path.join(workdir.current, "supabase", "migrations", "20240101000000_init.sql"),
            "select 1;\n",
          );
        }).pipe(Effect.provide(BunServices.layer)),
      )
        .then(() =>
          runSupabase(["migration", "squash", "--local"], {
            entrypoint: "legacy",
            cwd: workdir.current,
          }),
        )
        .then(({ exitCode, stdout, stderr }) => {
          expect(exitCode).toBe(0);
          expect(stripAnsi(stderr)).toContain(
            "supabase/migrations/20240101000000_init.sql is already the earliest migration.",
          );
          expect(stripAnsi(stdout)).toContain("Finished supabase migration squash.");
          expect(stripAnsi(stderr)).toContain(
            "Run supabase migration repair --status applied to update your remote migration history table.",
          );
        }),
  );
});
