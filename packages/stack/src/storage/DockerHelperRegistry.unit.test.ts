import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Ref } from "effect";
import { makeDockerHelperRegistry } from "./DockerHelperRegistry.ts";

it.effect("opens a helper once and closes it with the host scope", () =>
  Effect.gen(function* () {
    const opened = yield* Ref.make(0);
    const closed = yield* Ref.make<Array<string>>([]);
    const seen = yield* Ref.make<Array<string>>([]);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeDockerHelperRegistry("owner-one");
        const open = Ref.updateAndGet(opened, (count) => count + 1).pipe(
          Effect.map((count) => `helper-${String(count)}`),
        );
        const close = (id: string) => Ref.update(closed, (ids) => [...ids, id]);
        yield* registry.use("volume", open, close, (id) => Ref.update(seen, (ids) => [...ids, id]));
        yield* registry.use("volume", open, close, (id) => Ref.update(seen, (ids) => [...ids, id]));
        expect(yield* Ref.get(opened)).toBe(1);
        expect(yield* Ref.get(seen)).toEqual(["helper-1", "helper-1"]);
        expect(yield* Ref.get(closed)).toEqual([]);
      }),
    );
    expect(yield* Ref.get(closed)).toEqual(["helper-1"]);
  }),
);

it.effect("keeps the helper when a command fails", () =>
  Effect.gen(function* () {
    const opened = yield* Ref.make(0);
    const registry = yield* makeDockerHelperRegistry("owner-one");
    const open = Ref.updateAndGet(opened, (count) => count + 1).pipe(
      Effect.map((count) => `helper-${String(count)}`),
    );
    const close = (_id: string) => Effect.void;
    const failed = yield* registry
      .use("volume", open, close, () => Effect.fail("script"))
      .pipe(Effect.exit);
    expect(Exit.isFailure(failed)).toBe(true);
    const id = yield* registry.use("volume", open, close, (value) => Effect.succeed(value));
    expect(id).toBe("helper-1");
    expect(yield* Ref.get(opened)).toBe(1);
  }),
);

it.effect("closes only when an interrupted use entered the helper body", () =>
  Effect.gen(function* () {
    const opened = yield* Ref.make(0);
    const closed = yield* Ref.make<Array<string>>([]);
    const enteredFirst = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const waiterStarted = yield* Deferred.make<void>();
    const registry = yield* makeDockerHelperRegistry("owner-one");
    const open = Ref.updateAndGet(opened, (count) => count + 1).pipe(
      Effect.map((count) => `helper-${String(count)}`),
    );
    const close = (id: string) => Ref.update(closed, (ids) => [...ids, id]);
    const first = yield* registry
      .use("volume", open, close, () =>
        Deferred.succeed(enteredFirst, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(enteredFirst);
    const waiter = yield* Effect.gen(function* () {
      yield* Deferred.succeed(waiterStarted, undefined);
      return yield* registry.use("volume", open, close, () => Effect.succeed("unexpected"));
    }).pipe(Effect.forkChild);
    yield* Deferred.await(waiterStarted);
    const waiterExit = yield* Fiber.interrupt(waiter).pipe(Effect.andThen(Fiber.await(waiter)));
    expect(Exit.isFailure(waiterExit)).toBe(true);
    expect(yield* Ref.get(closed)).toEqual([]);
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.await(first);

    const reused = yield* registry.use("volume", open, close, (id) => Effect.succeed(id));
    expect(reused).toBe("helper-1");
    expect(yield* Ref.get(opened)).toBe(1);

    const enteredActive = yield* Deferred.make<void>();
    const active = yield* registry
      .use("volume", open, close, () =>
        Deferred.succeed(enteredActive, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(enteredActive);
    const exit = yield* Fiber.interrupt(active).pipe(Effect.andThen(Fiber.await(active)));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(yield* Ref.get(closed)).toEqual(["helper-1"]);

    const replacement = yield* registry.use("volume", open, close, (id) => Effect.succeed(id));
    expect(replacement).toBe("helper-2");
  }),
);
