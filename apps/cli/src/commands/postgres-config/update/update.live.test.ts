import { Cause, Data, Effect, Exit, Schema } from "effect";
import { expect } from "vitest";

import {
  expectPostgresConfigLiveOverride,
  experimentalProjectLiveFlags,
  type LiveFixtures,
  removePostgresConfigLiveOverride,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

/** Typed proof failures keep the bounded `get` poll and the restore attributable. */
class PostgresConfigLiveError extends Data.TaggedError("PostgresConfigLiveError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const liveFailure = (error: unknown): PostgresConfigLiveError =>
  new PostgresConfigLiveError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });

function proveOverride(
  cli: LiveFixtures["cli"],
  project: LiveFixtures["project"],
  key: string,
  expected: string | undefined,
  label: string,
) {
  return Effect.tryPromise({
    try: () => expectPostgresConfigLiveOverride(cli, project, key, expected, label),
    catch: liveFailure,
  });
}

function removeOverride(cli: LiveFixtures["cli"], project: LiveFixtures["project"], key: string) {
  return Effect.tryPromise({
    try: () => removePostgresConfigLiveOverride(cli, project, key),
    catch: liveFailure,
  });
}

// --no-restart skips the database restart; work_mem is a dynamic parameter, so
// the override still takes effect.
//
// Not wired to the test `signal`: an interrupt SIGKILLs an in-flight restore
// mid-request (the run's scope release kills the process group), so letting the
// bounded restore run out is strictly safer.
test("applies an override with --no-restart and get proves it", ({ cli, cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const flags = experimentalProjectLiveFlags(project);

      const target = Effect.gen(function* () {
        const updated = yield* cliEffect([
          "postgres-config",
          "update",
          "--config",
          "work_mem=7MB",
          ...flags,
          "--no-restart",
          "-o",
          "json",
        ]);
        expect(updated.exitCode, updated.stderr).toBe(0);
        expect(updated.stdout, updated.stderr).not.toBe("");
        const applied = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
        )(updated.stdout);
        expect(applied["work_mem"], updated.stdout).toBe("7MB");

        yield* proveOverride(
          cli,
          project,
          "work_mem",
          "7MB",
          "postgres-config get proof for postgres-config update",
        );
      });

      // The restore runs whatever the target did; neither failure hides the other.
      const targetExit = yield* Effect.exit(target);
      const cleanupExit = yield* Effect.exit(removeOverride(cli, project, "work_mem"));
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
      };
    }),
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
