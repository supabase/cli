import { DateTime, Effect, Exit, FileSystem, Schedule, Scope, Semaphore } from "effect";
import { namespaceError, type NamespaceError } from "./Capabilities.ts";
import { acquireLock, isBusy, takeSharedLock } from "./drivers/Sqlite.ts";

/**
 * Open reader connections this process currently holds, keyed by canonical digest lock path. A
 * second `acquireLock` on the same path would either be rejected by its own single-holder guard or
 * (worse) silently coalesce, since POSIX advisory locks belong to a process, not a descriptor. So
 * every local pin on the same generation shares this one connection, reference-counted, instead of
 * opening a second one; this is also the registry a retirement sweep's own `acquireLock` attempt
 * naturally defers to, since that attempt targets the same path and the same single-holder guard.
 */
const registry = new Map<string, { readonly scope: Scope.Closeable; refCount: number }>();

/**
 * Serializes the check-or-create section per path: checking `registry` and opening its connection
 * span several `yield*` suspension points, so two concurrent local pins on a brand new path would
 * otherwise both see it missing and race to open it. One semaphore per path, created and looked up
 * synchronously (never itself awaited to exist), rules that out.
 */
const locks = new Map<string, Semaphore.Semaphore>();
const semaphoreFor = (path: string): Semaphore.Semaphore => {
  const existing = locks.get(path);
  if (existing !== undefined) return existing;
  const created = Semaphore.makeUnsafe(1);
  locks.set(path, created);
  return created;
};

/** Rides out a retirement sweep's brief EXCLUSIVE hold instead of failing a concurrent pin. */
const pinRetrySchedule = Schedule.spaced("10 millis").pipe(
  Schedule.upTo({ duration: "2 seconds" }),
);

/**
 * Holds a SHARED lock on `lockPath` (one generation's digest lock file) for the life of the
 * returned scope: every consumer of a prepared generation's paths must stay inside this scope, and
 * must not resolve or create `lockPath`'s generation directory before this resolves. Touches the
 * lock file's mtime on first acquisition in this process, which is retirement's only liveness
 * signal for a holder in another process. The caller must ensure `lockPath`'s parent directory
 * already exists.
 */
export const pin = (
  lockPath: string,
): Effect.Effect<void, NamespaceError, Scope.Scope | FileSystem.FileSystem> =>
  Effect.acquireRelease(
    semaphoreFor(lockPath).withPermits(1)(
      Effect.gen(function* () {
        const existing = registry.get(lockPath);
        if (existing !== undefined) {
          existing.refCount++;
          return;
        }
        const scope = yield* Scope.make();
        yield* Effect.gen(function* () {
          const connection = yield* acquireLock(lockPath, "create").pipe(Scope.provide(scope));
          yield* takeSharedLock(connection).pipe(
            Effect.retry({ schedule: pinRetrySchedule, while: isBusy }),
          );
          const fs = yield* FileSystem.FileSystem;
          const now = DateTime.toDateUtc(yield* DateTime.now);
          yield* fs
            .utimes(lockPath, now, now)
            .pipe(Effect.mapError((cause) => namespaceError("pin-touch", cause)));
        }).pipe(Effect.tapError(() => Scope.close(scope, Exit.void)));
        registry.set(lockPath, { scope, refCount: 1 });
      }),
    ),
    () =>
      semaphoreFor(lockPath).withPermits(1)(
        Effect.suspend(() => {
          const entry = registry.get(lockPath);
          if (entry === undefined) return Effect.void;
          entry.refCount--;
          if (entry.refCount > 0) return Effect.void;
          registry.delete(lockPath);
          return Scope.close(entry.scope, Exit.void);
        }),
      ),
  );
