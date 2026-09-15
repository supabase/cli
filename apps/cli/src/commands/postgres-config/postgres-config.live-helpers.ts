import { Data, Effect } from "effect";

import {
  expectPostgresConfigLiveOverride,
  type LiveFixtures,
  removePostgresConfigLiveOverride,
} from "../../../tests/helpers/live.ts";

/** Typed proof failures keep the bounded `get` poll and the teardown attributable. */
class PostgresConfigLiveError extends Data.TaggedError("PostgresConfigLiveError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const liveFailure = (error: unknown): PostgresConfigLiveError =>
  new PostgresConfigLiveError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });

export function proveOverride(
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

export function removeOverride(
  cli: LiveFixtures["cli"],
  project: LiveFixtures["project"],
  key: string,
) {
  return Effect.tryPromise({
    try: () => removePostgresConfigLiveOverride(cli, project, key),
    catch: liveFailure,
  });
}
