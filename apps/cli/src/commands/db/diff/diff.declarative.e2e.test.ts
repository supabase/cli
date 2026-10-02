import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, FileSystem, Path } from "effect";

import {
  makeTempCliStackProject,
  overrideStackPorts,
  requireCliSuccess,
  runSupabaseEffect,
} from "../../../../tests/helpers/cli.ts";

const CLI_COMMAND_TIMEOUT_MS = 60_000;
const STACK_START_TIMEOUT_MS = 280_000;
const DIFF_COMMAND_TIMEOUT_MS = 280_000;
const CLEANUP_TIMEOUT_MS = 120_000;
const LIFECYCLE_MARGIN_MS = 30_000;
const DIFF_TEST_TIMEOUT_MS =
  CLI_COMMAND_TIMEOUT_MS +
  STACK_START_TIMEOUT_MS +
  CLI_COMMAND_TIMEOUT_MS * 2 +
  DIFF_COMMAND_TIMEOUT_MS +
  CLEANUP_TIMEOUT_MS +
  LIFECYCLE_MARGIN_MS;

class StackProjectSetupError extends Data.TaggedError("StackProjectSetupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class StackProjectCleanupError extends Data.TaggedError("StackProjectCleanupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class StackPortOverrideError extends Data.TaggedError("StackPortOverrideError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const withTempStackProject = <A, E, R>(
  use: (project: Awaited<ReturnType<typeof makeTempCliStackProject>>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | StackProjectSetupError, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => makeTempCliStackProject("sb-db-diff-e2e-"),
      catch: (cause) =>
        new StackProjectSetupError({ message: "temp stack project setup failed", cause }),
    }),
    use,
    (project) =>
      Effect.tryPromise({
        try: () => project.cleanup(),
        catch: (cause) =>
          new StackProjectCleanupError({ message: "temp stack project cleanup failed", cause }),
      }).pipe(Effect.ignore),
  );

const overrideStackPortsIn = (projectDir: string) =>
  Effect.tryPromise({
    try: () => overrideStackPorts(projectDir),
    catch: (cause) =>
      new StackPortOverrideError({ message: `failed to override ports in ${projectDir}`, cause }),
  });

// Regression coverage: `filterPublicBuiltInDefaults()` treated PUBLIC's implicit built-in
// privilege as a no-op on both sides of a diff, so a declarative schema's `REVOKE ... FROM
// PUBLIC` on a function was silently dropped from the generated migration. Fixed upstream in
// @supabase/pg-delta@1.0.0-alpha.33. Uses local Docker-stack e2e coverage; see AGENTS.md's "E2e
// tests" section.
describe("supabase db diff (e2e, pg-delta declarative privileges)", () => {
  it.live(
    "keeps REVOKE ... FROM PUBLIC on a function when diffing a declarative schema against local",
    () =>
      withTempStackProject((project) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const projectDir = project.dir;

          const init = yield* runSupabaseEffect(["init"], {
            cwd: projectDir,
            exitTimeoutMs: CLI_COMMAND_TIMEOUT_MS,
          });
          requireCliSuccess(init, "init setup");
          yield* overrideStackPortsIn(projectDir);

          // Exclude the heaviest, least relevant services — `db diff` only needs the
          // local Postgres container reachable, same rationale as stop/status.
          const start = yield* runSupabaseEffect(
            ["start", "--exclude", "studio", "--exclude", "logflare", "--exclude", "vector"],
            { cwd: projectDir, exitTimeoutMs: STACK_START_TIMEOUT_MS },
          );
          requireCliSuccess(start, "start setup");

          // Minimal, deterministic repro: execute a fresh function's implicit PUBLIC EXECUTE grant,
          // explicitly revoked, directly against the local database. `db query` is setup only; keep
          // each statement in its own invocation, since it sends one prepared statement at a time.
          const createFunction = yield* runSupabaseEffect(
            [
              "db",
              "query",
              `create function public.probe_fn()
returns void
language sql
as $$ select 1; $$;`,
              "--local",
            ],
            { cwd: projectDir, exitTimeoutMs: CLI_COMMAND_TIMEOUT_MS },
          );
          requireCliSuccess(createFunction, "db query create-function setup");

          const revoke = yield* runSupabaseEffect(
            ["db", "query", "revoke execute on function public.probe_fn() from public;", "--local"],
            { cwd: projectDir, exitTimeoutMs: CLI_COMMAND_TIMEOUT_MS },
          );
          requireCliSuccess(revoke, "db query revoke setup");

          const diff = yield* runSupabaseEffect(
            ["db", "diff", "--local", "--use-pg-delta", "-f", "revoke_public_execute"],
            { cwd: projectDir, exitTimeoutMs: DIFF_COMMAND_TIMEOUT_MS },
          );
          expect(diff.exitCode, `stdout:\n${diff.stdout}\nstderr:\n${diff.stderr}`).toBe(0);

          const migrationsDir = path.join(projectDir, "supabase", "migrations");
          const written =
            (yield* fs.exists(migrationsDir)) &&
            (yield* fs.readDirectory(migrationsDir)).find((f) =>
              f.endsWith("_revoke_public_execute.sql"),
            );
          expect(written, `no migration written; stderr:\n${diff.stderr}`).toBeTruthy();
          const sql = yield* fs.readFileString(path.join(migrationsDir, written as string));

          // Anchored to the function's own REVOKE statement, up to its terminating `;`, so this
          // cannot pass on an unrelated PUBLIC mention elsewhere in the file.
          expect(sql).toMatch(
            /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+"?public"?\s*\.\s*"?probe_fn"?\s*\(\)/i,
          );
          expect(sql).toMatch(
            /REVOKE\s+(?:ALL|EXECUTE)\s+ON\s+FUNCTION\s+"?public"?\s*\.\s*"?probe_fn"?\s*\(\)\s+FROM\s+[^;]*PUBLIC[^;]*;/i,
          );
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    DIFF_TEST_TIMEOUT_MS,
  );
});
