import { expect, it } from "@effect/vitest";
import { Effect, Exit, Ref } from "effect";
import { makeDockerHelperRegistry } from "./DockerHelperRegistry.ts";

it.effect("opens a helper once and closes it with the host scope", () =>
  Effect.gen(function* () {
    const opened = yield* Ref.make(0);
    const closed = yield* Ref.make<Array<string>>([]);
    const seen = yield* Ref.make<Array<string>>([]);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeDockerHelperRegistry;
        const open = Ref.updateAndGet(opened, (count) => count + 1).pipe(
          Effect.map((count) => ({ id: `helper-${String(count)}`, created: true })),
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
    const registry = yield* makeDockerHelperRegistry;
    const open = Ref.updateAndGet(opened, (count) => count + 1).pipe(
      Effect.map((count) => ({ id: `helper-${String(count)}`, created: true })),
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

it.effect("does not remove a helper this process did not create", () =>
  Effect.gen(function* () {
    const closed = yield* Ref.make<Array<string>>([]);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeDockerHelperRegistry;
        yield* registry.use(
          "volume",
          Effect.succeed({ id: "adopted", created: false }),
          (id) => Ref.update(closed, (ids) => [...ids, id]),
          (id) => Effect.succeed(id),
        );
      }),
    );
    expect(yield* Ref.get(closed)).toEqual([]);
  }),
);
