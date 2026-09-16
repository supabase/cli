import { Data, Effect } from "effect";

import { type LiveFixtures, requireLiveSuccess } from "./live.ts";

type LiveCliEffect = LiveFixtures["cliEffect"];
type LiveRun = Effect.Success<ReturnType<LiveCliEffect>>;

/** Typed live failures; `message` is a field so vitest can serialize the error. */
class SecretsLiveError extends Data.TaggedError("SecretsLiveError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function requireSuccess(result: LiveRun, label: string) {
  return Effect.try({
    try: () => {
      requireLiveSuccess(result, label);
    },
    catch: (error) =>
      new SecretsLiveError({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      }),
  });
}

/** Exact-name cleanup; unsetting an already-removed secret is tolerated. */
export function unsetSecret(cliEffect: LiveCliEffect, name: string, ref: string) {
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
