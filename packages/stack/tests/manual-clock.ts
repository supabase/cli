import { Clock, Deferred, Duration, Effect } from "effect";

/**
 * A clock that moves only when the test advances it; `sleeping` waits for a pending sleep of that
 * duration. Wake-ups run on a later macrotask, since completing a deferred resumes its fiber
 * inline and a sleeper and the test would otherwise drive each other without yielding to I/O.
 */
export const makeManualClock = Effect.gen(function* () {
  let now = yield* Clock.currentTimeMillis;
  const sleeps = new Set<{
    readonly millis: number;
    readonly until: number;
    readonly woken: Deferred.Deferred<void>;
  }>();
  const waiters = new Set<{ readonly millis: number; readonly ready: Deferred.Deferred<void> }>();
  const wake = (deferred: Deferred.Deferred<void>) =>
    setImmediate(() => Deferred.doneUnsafe(deferred, Effect.void));
  const nanos = () => BigInt(now) * 1_000_000n;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: (duration) =>
      Effect.suspend(() => {
        const millis = Duration.toMillis(duration);
        if (millis <= 0) return Effect.void;
        const entry = { millis, until: now + millis, woken: Deferred.makeUnsafe<void>() };
        sleeps.add(entry);
        for (const waiter of waiters)
          if (waiter.millis === millis) {
            waiters.delete(waiter);
            wake(waiter.ready);
          }
        return Deferred.await(entry.woken).pipe(
          Effect.ensuring(Effect.sync(() => sleeps.delete(entry))),
        );
      }),
  };
  return {
    clock,
    sleeping: (millis: number) =>
      Effect.suspend(() => {
        if ([...sleeps].some((entry) => entry.millis === millis)) return Effect.void;
        const waiter = { millis, ready: Deferred.makeUnsafe<void>() };
        waiters.add(waiter);
        return Deferred.await(waiter.ready).pipe(
          Effect.ensuring(Effect.sync(() => waiters.delete(waiter))),
        );
      }),
    advance: (millis: number) =>
      Effect.sync(() => {
        now += millis;
        for (const entry of sleeps)
          if (entry.until <= now) {
            sleeps.delete(entry);
            wake(entry.woken);
          }
      }),
  };
});

export type ManualClock = Effect.Success<typeof makeManualClock>;
