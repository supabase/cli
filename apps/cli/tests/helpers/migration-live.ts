import { Data, Effect } from "effect";

import { type LiveFixtures, type LiveProject, queryLiveDb, removeLiveMigration } from "./live.ts";

/** Typed live boundary failure; preserve the foreign error for SQLSTATE checks. */
export class MigrationLiveError extends Data.TaggedError("MigrationLiveError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const liveFailure = (cause: unknown) =>
  new MigrationLiveError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

export function queryMigrationDb<T extends Record<string, unknown>>(
  dbUrl: string,
  query: string,
  values?: ReadonlyArray<unknown>,
) {
  return Effect.tryPromise({
    try: () => queryLiveDb<T>(dbUrl, query, values),
    catch: liveFailure,
  });
}

export function removeMigration(cli: LiveFixtures["cli"], project: LiveProject, version: string) {
  return Effect.tryPromise({
    try: () => removeLiveMigration(cli, project, version),
    catch: liveFailure,
  });
}
