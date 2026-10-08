import { DateTime, Effect, FileSystem, Schedule, Scope } from "effect";
import { namespaceError, type NamespaceError } from "./Capabilities.ts";
import { acquireLock, isBusy, takeSharedLock } from "./drivers/Sqlite.ts";

/** Rides out a retirement sweep's brief EXCLUSIVE hold instead of failing a concurrent pin. */
const pinRetrySchedule = Schedule.spaced("10 millis").pipe(
  Schedule.upTo({ duration: "2 seconds" }),
);

/**
 * Holds a SHARED lock on `lockPath` (one generation's digest lock file) for the life of the
 * enclosing scope: every consumer of a prepared generation's paths must stay inside this scope, and
 * must not resolve or create `lockPath`'s generation directory before this resolves. Touches the
 * lock file's mtime on acquisition, which is retirement's only liveness signal for a holder in
 * another process. The caller must ensure `lockPath`'s parent directory already exists.
 */
export const pin = Effect.fn("Pin.pin")(function* (
  lockPath: string,
): Effect.fn.Return<void, NamespaceError, Scope.Scope | FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const connection = yield* acquireLock(lockPath, "create");
  yield* takeSharedLock(connection).pipe(
    Effect.retry({ schedule: pinRetrySchedule, while: isBusy }),
  );
  const now = DateTime.toDateUtc(yield* DateTime.now);
  yield* fs
    .utimes(lockPath, now, now)
    .pipe(Effect.mapError((cause) => namespaceError("pin-touch", cause)));
});
