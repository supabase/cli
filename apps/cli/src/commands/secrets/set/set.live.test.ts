import { randomUUID } from "node:crypto";

import { Cause, Data, Effect, Exit } from "effect";
import { expect } from "vitest";

import { type LiveFixtures, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";

type LiveCliEffect = LiveFixtures["cliEffect"];

/** Typed live failures; `message` is a field so vitest can serialize the error. */
class SecretsLiveError extends Data.TaggedError("SecretsLiveError")<{
  readonly message: string;
}> {}

/** Exact-name cleanup; unsetting an already-removed secret is tolerated. */
function unsetSecret(cliEffect: LiveCliEffect, name: string, ref: string) {
  return Effect.gen(function* () {
    const cleanup = yield* cliEffect(["secrets", "unset", name, "--project-ref", ref, "--yes"]);
    if (
      cleanup.exitCode !== 0 &&
      !/not found|does not exist/iu.test(`${cleanup.stdout}\n${cleanup.stderr}`)
    ) {
      return yield* new SecretsLiveError({
        message: `secrets unset cleanup failed:\n${cleanup.stdout}\n${cleanup.stderr}`,
      });
    }
  });
}

// Not wired to the test `signal`: an interrupt SIGKILLs an in-flight cleanup
// mid-request (the run's scope release kills the process group), so letting the
// bounded cleanup run out is strictly safer.
test("sets a secret on the remote project", ({ cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const name = `CLI_E2E_SET_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;

      const target = Effect.gen(function* () {
        const result = yield* cliEffect([
          "secrets",
          "set",
          `${name}=live-value`,
          "--project-ref",
          project.ref,
        ]);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout).toContain("Finished");
      });

      // The cleanup runs whatever the target did; neither failure hides the other.
      const targetExit = yield* Effect.exit(target);
      const cleanupExit = yield* Effect.exit(unsetSecret(cliEffect, name, project.ref));
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
      };
    }),
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
