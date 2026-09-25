import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Ref } from "effect";
import { makeDockerHelperRegistry } from "./DockerHelperRegistry.ts";

const counters = Effect.gen(function* () {
  const opened = yield* Ref.make(0);
  const closed = yield* Ref.make<Array<string>>([]);
  const open = Ref.updateAndGet(opened, (count) => count + 1).pipe(
    Effect.map((count) => `helper-${String(count)}`),
  );
  const close = (id: string) => Ref.update(closed, (ids) => [...ids, id]);
  return { opened, closed, open, close };
});

it.effect("opens a helper once and closes it with the host scope", () =>
  Effect.gen(function* () {
    const { opened, closed, open, close } = yield* counters;
    const seen = yield* Ref.make<Array<string>>([]);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeDockerHelperRegistry("owner-one");
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
    const { opened, open, close } = yield* counters;
    const registry = yield* makeDockerHelperRegistry("owner-one");
    const failed = yield* registry
      .use("volume", open, close, () => Effect.fail("script"))
      .pipe(Effect.exit);
    expect(Exit.isFailure(failed)).toBe(true);
    const id = yield* registry.use("volume", open, close, (value) => Effect.succeed(value));
    expect(id).toBe("helper-1");
    expect(yield* Ref.get(opened)).toBe(1);
  }),
);

it.effect("runs concurrent uses of one helper and of different helpers together", () =>
  Effect.gen(function* () {
    const { opened, open, close } = yield* counters;
    const registry = yield* makeDockerHelperRegistry("owner-one");
    const release = yield* Deferred.make<void>();
    const entered = yield* Ref.make<Array<string>>([]);
    const allEntered = yield* Deferred.make<void>();
    const hold = (label: string) => (id: string) =>
      Effect.gen(function* () {
        const labels = yield* Ref.updateAndGet(entered, (values) => [...values, label]);
        if (labels.length === 3) yield* Deferred.succeed(allEntered, undefined);
        yield* Deferred.await(release);
        return id;
      });
    const uses = yield* Effect.all(
      [
        registry.use("volume-a", open, close, hold("first")),
        registry.use("volume-a", open, close, hold("second")),
        registry.use("volume-b", open, close, hold("other")),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);
    yield* Deferred.await(allEntered);
    yield* Deferred.succeed(release, undefined);
    const ids = yield* Fiber.join(uses);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(yield* Ref.get(opened)).toBe(2);
  }),
);

it.effect("closes an interrupted use's helper after its other uses finish", () =>
  Effect.gen(function* () {
    const { closed, open, close } = yield* counters;
    const registry = yield* makeDockerHelperRegistry("owner-one");
    const enteredInterrupted = yield* Deferred.make<void>();
    const enteredActive = yield* Deferred.make<void>();
    const releaseActive = yield* Deferred.make<void>();
    const interrupted = yield* registry
      .use("volume", open, close, () =>
        Deferred.succeed(enteredInterrupted, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(enteredInterrupted);
    const active = yield* registry
      .use("volume", open, close, (id) =>
        Deferred.succeed(enteredActive, undefined).pipe(
          Effect.andThen(Deferred.await(releaseActive)),
          Effect.as(id),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(enteredActive);

    yield* Effect.sync(() => interrupted.interruptUnsafe());
    expect(yield* Ref.get(closed)).toEqual([]);
    yield* Deferred.succeed(releaseActive, undefined);
    expect(yield* Fiber.join(active)).toBe("helper-1");
    const exit = yield* Fiber.await(interrupted);

    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(yield* Ref.get(closed)).toEqual(["helper-1"]);
    const replacement = yield* registry.use("volume", open, close, (id) => Effect.succeed(id));
    expect(replacement).toBe("helper-2");
  }),
);

it.effect("keeps the helper when a use is interrupted before it starts", () =>
  Effect.gen(function* () {
    const { closed, open, close } = yield* counters;
    const registry = yield* makeDockerHelperRegistry("owner-one");
    const opening = yield* Deferred.make<void>();
    const releaseOpen = yield* Deferred.make<void>();
    const slowOpen = Deferred.succeed(opening, undefined).pipe(
      Effect.andThen(Deferred.await(releaseOpen)),
      Effect.andThen(open),
    );
    const first = yield* registry
      .use("volume", slowOpen, close, (id) => Effect.succeed(id))
      .pipe(Effect.forkChild);
    yield* Deferred.await(opening);
    const waiterStarted = yield* Deferred.make<void>();
    const waiter = yield* Deferred.succeed(waiterStarted, undefined).pipe(
      Effect.andThen(registry.use("volume", open, close, (id) => Effect.succeed(id))),
      Effect.forkChild,
    );
    yield* Deferred.await(waiterStarted);
    const waiterExit = yield* Fiber.interrupt(waiter).pipe(Effect.andThen(Fiber.await(waiter)));
    expect(Exit.hasInterrupts(waiterExit)).toBe(true);
    yield* Deferred.succeed(releaseOpen, undefined);

    expect(yield* Fiber.join(first)).toBe("helper-1");
    expect(yield* Ref.get(closed)).toEqual([]);
  }),
);
