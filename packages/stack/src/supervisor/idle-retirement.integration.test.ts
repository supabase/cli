import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { ServiceInstanceIdSchema } from "../public/ServiceInstanceId.ts";
import { makeIdleRetirement } from "./IdleRetirement.ts";

const first = ServiceInstanceIdSchema.make("11111111-1111-4111-8111-111111111111");
const second = ServiceInstanceIdSchema.make("22222222-2222-4222-8222-222222222222");

describe("idle retirement timers", () => {
  it.effect("fires only after the current arm delay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const retired = yield* Ref.make<ReadonlyArray<string>>([]);
        const timers = yield* makeIdleRetirement((id, generation) =>
          Ref.update(retired, (ids) => [...ids, `${id}:${generation}`]),
        );
        yield* timers.arm(first, 1, 5);
        yield* TestClock.adjust("4 seconds");
        expect(yield* Ref.get(retired)).toEqual([]);
        yield* TestClock.adjust("1 second");
        expect(yield* Ref.get(retired)).toEqual([`${first}:1`]);
      }),
    ),
  );

  it.effect("rearming replaces the old timer and cancellation prevents retirement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const retired = yield* Ref.make<ReadonlyArray<string>>([]);
        const timers = yield* makeIdleRetirement((id, generation) =>
          Ref.update(retired, (ids) => [...ids, `${id}:${generation}`]),
        );
        yield* timers.arm(first, 1, 5);
        yield* TestClock.adjust("4 seconds");
        yield* timers.arm(first, 2, 5);
        yield* TestClock.adjust("1 second");
        expect(yield* Ref.get(retired)).toEqual([]);
        yield* TestClock.adjust("4 seconds");
        expect(yield* Ref.get(retired)).toEqual([`${first}:2`]);
        yield* timers.arm(second, 1, 5);
        yield* timers.cancel(second);
        yield* timers.arm(
          ServiceInstanceIdSchema.make("33333333-3333-4333-8333-333333333333"),
          1,
          5,
        );
        yield* timers.arm(
          ServiceInstanceIdSchema.make("33333333-3333-4333-8333-333333333333"),
          2,
          0,
        );
        yield* TestClock.adjust("5 seconds");
        expect(yield* Ref.get(retired)).toEqual([`${first}:2`]);
      }),
    ),
  );

  it.effect("keeps timers independent and ignores disabled timeout values", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const retired = yield* Ref.make<ReadonlyArray<string>>([]);
        const timers = yield* makeIdleRetirement((id, generation) =>
          Ref.update(retired, (ids) => [...ids, `${id}:${generation}`]),
        );
        yield* timers.arm(first, 1, 1);
        yield* timers.arm(second, 1, 2);
        yield* timers.arm(
          ServiceInstanceIdSchema.make("33333333-3333-4333-8333-333333333333"),
          1,
          0,
        );
        yield* TestClock.adjust("1 second");
        expect(yield* Ref.get(retired)).toEqual([`${first}:1`]);
        yield* TestClock.adjust("1 second");
        expect(yield* Ref.get(retired)).toEqual([`${first}:1`, `${second}:1`]);
      }),
    ),
  );
});
