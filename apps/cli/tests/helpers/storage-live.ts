import { Data, Effect } from "effect";

import { type LiveFixtures, removeStorageLiveObject } from "./live.ts";

/** Typed live failures; `message` is a field so vitest can serialize the error. */
class StorageLiveError extends Data.TaggedError("StorageLiveError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Exact-path cleanup; removing an already-deleted object is tolerated. */
export function removeObject(cli: LiveFixtures["cli"], remote: string) {
  return Effect.tryPromise({
    try: () => removeStorageLiveObject(cli, remote),
    catch: (error) =>
      new StorageLiveError({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      }),
  });
}
