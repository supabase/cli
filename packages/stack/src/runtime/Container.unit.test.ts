import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Ref, Scope } from "effect";
import { ContainerError, makeHostGateway } from "./Container.ts";

const gatewayAddress = "192.168.65.254";

const gatedProbe = Effect.fnUntraced(function* (result: string | undefined) {
  const release = yield* Deferred.make<void>();
  const runs = yield* Ref.make(0);
  const probe = Ref.update(runs, (count) => count + 1).pipe(
    Effect.andThen(Deferred.await(release)),
    Effect.as(result),
  );
  return { probe, runs, release: Deferred.succeed(release, undefined) };
});

describe("host gateway", () => {
  it.effect("prefetches without waiting and lets a later resolve await the same probe", () =>
    Effect.gen(function* () {
      const gateway = yield* makeHostGateway;
      const { probe, runs, release } = yield* gatedProbe(gatewayAddress);

      yield* gateway.prefetch(probe);
      const waiting = yield* gateway.resolve(probe).pipe(Effect.forkChild);
      yield* release;

      expect(yield* Fiber.join(waiting)).toBe(gatewayAddress);
      expect(yield* gateway.resolve(probe)).toBe(gatewayAddress);
      expect(yield* Ref.get(runs)).toBe(1);
    }),
  );

  it.effect("retries once for a waiter whose background probe finds no target", () =>
    Effect.gen(function* () {
      const gateway = yield* makeHostGateway;
      const background = yield* gatedProbe(undefined);
      const later = yield* gatedProbe(gatewayAddress);

      yield* gateway.prefetch(background.probe);
      const waiting = yield* gateway
        .resolve(later.probe)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* background.release;
      yield* later.release;

      expect(yield* Fiber.join(waiting)).toBe(gatewayAddress);
      expect(yield* Ref.get(later.runs)).toBe(1);
      expect(yield* gateway.resolve(later.probe)).toBe(gatewayAddress);
      expect(yield* Ref.get(later.runs)).toBe(1);
    }),
  );

  it.effect("caches a probe failure for later resolves without probing again", () =>
    Effect.gen(function* () {
      const gateway = yield* makeHostGateway;
      const runs = yield* Ref.make(0);
      const unsupported = new ContainerError({ operation: "host-gateway", message: "unsupported" });
      const probe = Ref.update(runs, (count) => count + 1).pipe(
        Effect.andThen(Effect.fail(unsupported)),
      );

      expect(yield* Effect.flip(gateway.resolve(probe))).toBe(unsupported);
      expect(yield* Effect.flip(gateway.resolve(probe))).toBe(unsupported);
      expect(yield* Ref.get(runs)).toBe(1);
    }),
  );

  it.effect("keeps the probe running when a waiting resolve is interrupted", () =>
    Effect.gen(function* () {
      const gateway = yield* makeHostGateway;
      const { probe, runs, release } = yield* gatedProbe(gatewayAddress);

      const waiting = yield* gateway
        .resolve(probe)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(waiting);
      yield* release;

      expect(yield* gateway.resolve(probe)).toBe(gatewayAddress);
      expect(yield* Ref.get(runs)).toBe(1);
    }),
  );

  it.effect("interrupts its probe when the owning scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const gateway = yield* makeHostGateway.pipe(Scope.provide(scope));
      const interrupted = yield* Deferred.make<void>();

      yield* gateway.prefetch(
        Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
      );
      yield* Scope.close(scope, Exit.void);

      expect(yield* Deferred.isDone(interrupted)).toBe(true);
      expect(yield* gateway.resolve(Effect.never)).toBe("host-gateway");
    }),
  );
});
