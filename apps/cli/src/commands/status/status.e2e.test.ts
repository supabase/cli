import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Schema } from "effect";

import {
  makeTempCliStackProject,
  overrideStackPorts,
  requireCliSuccess,
  runSupabaseEffect,
} from "../../../tests/helpers/cli.ts";

const CLI_COMMAND_TIMEOUT_MS = 60_000;
const STACK_START_TIMEOUT_MS = 280_000;
const STATUS_COMMAND_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 120_000;
const LIFECYCLE_MARGIN_MS = 30_000;
// The stack project's teardown is released inside the test's own scope, so its budget is part
// of this timeout rather than a separate hook timeout.
const STATUS_TEST_TIMEOUT_MS =
  CLI_COMMAND_TIMEOUT_MS +
  STACK_START_TIMEOUT_MS +
  STATUS_COMMAND_TIMEOUT_MS * 2 +
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

const jsonValue = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * Owns one temp stack project for `use`. Teardown failures are swallowed so a cleanup problem
 * cannot fail a test whose assertions already passed.
 */
const withTempStackProject = <A, E, R>(
  use: (project: Awaited<ReturnType<typeof makeTempCliStackProject>>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | StackProjectSetupError, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => makeTempCliStackProject("sb-status-e2e-"),
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

// See stop.e2e.test.ts for why `describe` (not a Management-API gate) is
// the right reuse here: `status` never calls the Management API, only the real
// Docker daemon the cli-e2e-ci runner provides. See AGENTS.md's "e2e tests"
// section for the full convention.
describe("supabase status (e2e)", () => {
  it.live(
    "reports a running local stack in pretty and json modes",
    () =>
      withTempStackProject((project) =>
        Effect.gen(function* () {
          const projectDir = project.dir;

          const init = yield* runSupabaseEffect(["init"], {
            cwd: projectDir,
            exitTimeoutMs: CLI_COMMAND_TIMEOUT_MS,
          });
          requireCliSuccess(init, "init setup");
          yield* overrideStackPortsIn(projectDir);

          const start = yield* runSupabaseEffect(
            ["start", "--exclude", "studio", "--exclude", "logflare", "--exclude", "vector"],
            { cwd: projectDir, exitTimeoutMs: STACK_START_TIMEOUT_MS },
          );
          requireCliSuccess(start, "start setup");

          const pretty = yield* runSupabaseEffect(["status"], {
            cwd: projectDir,
            exitTimeoutMs: STATUS_COMMAND_TIMEOUT_MS,
          });
          expect(pretty.exitCode, `stdout:\n${pretty.stdout}\nstderr:\n${pretty.stderr}`).toBe(0);
          expect(`${pretty.stdout}${pretty.stderr}`).toContain("is running");
          expect(pretty.stdout).toContain("Project URL");
          expect(pretty.stdout).toContain("Database");

          const json = yield* runSupabaseEffect(["status", "-o", "json"], {
            cwd: projectDir,
            exitTimeoutMs: STATUS_COMMAND_TIMEOUT_MS,
          });
          expect(json.exitCode, `stdout:\n${json.stdout}\nstderr:\n${json.stderr}`).toBe(0);
          const parsed = yield* jsonValue(json.stdout);
          expect(parsed).toMatchObject({
            API_URL: expect.stringContaining("http"),
            DB_URL: expect.stringContaining("postgresql://"),
          });
        }),
      ),
    STATUS_TEST_TIMEOUT_MS,
  );
});
