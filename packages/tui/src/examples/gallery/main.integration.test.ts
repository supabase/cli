import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { run } from "../../runtime/public.ts";
import { shown, withTerminal, Written } from "../../runtime/test-support.ts";
import { TestTerminal } from "../../terminal/testing.ts";
import { program } from "./main.ts";

const buildLine = 1;
const dbLine = 2;

/** Waits for writes until the visible rows satisfy `ready`; the render throttle makes the frame count per tick vary. */
const untilShown = (ready: (lines: ReadonlyArray<string>) => boolean) =>
  Effect.gen(function* () {
    const written = yield* Written;
    yield* TestClock.adjust("16 millis");
    for (let lines = yield* shown; !ready(lines); lines = yield* shown) yield* written.next;
    return yield* shown;
  });

describe("gallery live section", () => {
  it.effect(
    "ticks both spinners, shows db as succeeded after enough ticks, and finishes on Enter",
    () =>
      withTerminal(
        Effect.gen(function* () {
          const test = yield* TestTerminal;
          const written = yield* Written;
          const running = yield* run(program).pipe(Effect.forkScoped({ startImmediately: true }));
          yield* written.next;
          const first = yield* shown;
          expect(first[buildLine]).toBe("⠋ Building functions");
          expect(first[dbLine]).toBe("⠋ Applying migrations");

          yield* TestClock.adjust("80 millis");
          const ticked = yield* untilShown(
            (lines) =>
              lines[buildLine]?.startsWith("⠙") === true && lines[dbLine]?.startsWith("⠙") === true,
          );
          expect(ticked[buildLine]).toBe("⠙ Building functions");
          expect(ticked[dbLine]).toBe("⠙ Applying migrations");

          yield* Effect.replicateEffect(TestClock.adjust("80 millis"), 39, { discard: true });
          const succeeded = yield* untilShown((lines) => lines[dbLine]?.startsWith("✔") === true);
          expect(succeeded[dbLine]).toBe("✔ Applying migrations");

          yield* TestClock.adjust("80 millis");
          const later = yield* untilShown((lines) => lines[buildLine] !== succeeded[buildLine]);
          expect(later[dbLine]).toBe("✔ Applying migrations");

          yield* test.type("\r");

          yield* Fiber.join(running);
        }),
      ),
  );
});
