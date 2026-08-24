import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect } from "vitest";
import { withManagedPortLease } from "./manager.ts";
import type { PortLease } from "../PortAllocator.ts";

describe("managed port lease ownership", () => {
  it.effect("releases an acquired lease when use is interrupted", () =>
    Effect.gen(function* () {
      const acquired = yield* Deferred.make<void>();
      const hold = yield* Deferred.make<void>();
      let releases = 0;
      const lease: PortLease = {
        ports: { apiPort: 54321 },
        reserve: () => Effect.void,
        release: () => Effect.void,
        releaseAll: Effect.sync(() => {
          releases += 1;
        }),
      };

      const fiber = yield* withManagedPortLease(
        Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Effect.succeed(lease))),
        () => Deferred.await(hold),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(acquired);
      yield* Fiber.interrupt(fiber);
      expect(releases).toBe(1);

      let failedReleases = 0;
      const failedLease: PortLease = {
        ports: { apiPort: 54322 },
        reserve: () => Effect.void,
        release: () => Effect.void,
        releaseAll: Effect.sync(() => {
          failedReleases += 1;
        }),
      };
      const failed = yield* withManagedPortLease(Effect.succeed(failedLease), () =>
        Effect.fail("use failed"),
      ).pipe(Effect.scoped, Effect.exit);

      expect(Exit.isFailure(failed)).toBe(true);
      expect(failedReleases).toBe(1);
    }),
  );
});
