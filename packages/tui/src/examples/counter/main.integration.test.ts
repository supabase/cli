import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";

import { TestTerminal } from "../../terminal/testing.ts";
import { run } from "../../runtime/public.ts";
import { nextFrame, shown, withTerminal, Written } from "../../runtime/test-support.ts";
import { program } from "./main.ts";

describe("counter example", () => {
  it.effect("counts with the arrow keys and finishes on q with the final count", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;
        const running = yield* run(program).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* written.next;
        expect(yield* shown).toEqual([
          "Counter",
          "0",
          "up/+ increment  down/- decrement  r reset  q quit",
        ]);

        yield* test.type("\x1b[A");
        yield* nextFrame;
        yield* test.type("\x1b[A");
        yield* nextFrame;
        yield* test.type("-");
        yield* nextFrame;
        expect((yield* shown)[1]).toBe("1");

        yield* test.type("q");

        expect(yield* Fiber.join(running)).toBe(1);
      }),
    ),
  );

  it.effect("counts two keys delivered in one read and ignores Alt+q", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;
        const running = yield* run(program).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* written.next;

        yield* test.type("++");
        yield* test.type("\x1bq");
        yield* test.type("+");
        yield* test.type("q");

        expect(yield* Fiber.join(running)).toBe(3);
      }),
    ),
  );
});
