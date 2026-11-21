import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Option, Schema } from "effect";

import * as Terminal from "../terminal/terminal.ts";
import { TestTerminal } from "../terminal/testing.ts";
import { screen } from "../view/screen.ts";
import { text } from "../view/view.ts";
import { makeProgram, run } from "./run.ts";
import { keyProgram, shown, withTerminal, Written } from "./test-support.ts";

const released = { paused: true, raw: false, listenerCount: 0 };

/** Its equivalence cannot be derived, which `run` only finds out after it owns the terminal. */
const underivableModel = makeProgram({
  Model: Schema.String.pipe(
    Schema.overrideToEquivalence(() => {
      throw new Error("no equivalence for this model");
    }),
  ),
  init: () => ({ model: "" }),
  update: (model) => ({ model }),
  view: () => screen(text("never drawn")),
  result: () => Option.none(),
});

/** Starts a key-reading run and returns once its first frame is on screen, so it owns stdin. */
const startKeys = Effect.gen(function* () {
  const written = yield* Written;
  yield* written.discard;
  const running = yield* run(keyProgram()).pipe(Effect.forkScoped({ startImmediately: true }));
  yield* written.next;
  return running;
});

describe("Tui.run terminal ownership", () => {
  it.effect("fails a second concurrent run with busy while the first run completes normally", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const first = yield* startKeys;

        const second = yield* run(keyProgram()).pipe(Effect.flip);

        expect(second).toBeInstanceOf(Terminal.TerminalError);
        expect(second.reason).toBe("busy");
        expect(yield* test.inputState).toMatchObject({ paused: false, raw: true });

        yield* test.type("q");

        expect(yield* Fiber.join(first)).toBe("stopped");
        expect(yield* shown).toEqual(["keys: q"]);
        expect(yield* test.rawModeTransitions).toEqual([true, false]);
        expect(yield* test.inputState).toEqual(released);
      }),
    ),
  );

  it.effect("lets a run start once the previous one has succeeded", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const first = yield* startKeys;
        yield* test.type("q");
        yield* Fiber.join(first);

        const second = yield* startKeys;
        yield* test.type("q");

        expect(yield* Fiber.join(second)).toBe("stopped");
        expect(yield* test.rawModeTransitions).toEqual([true, false, true, false]);
      }),
    ),
  );

  it.effect("lets a run start once the previous one has been interrupted", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const first = yield* startKeys;
        yield* test.type("\x03");
        expect(Exit.hasInterrupts(yield* Fiber.await(first))).toBe(true);

        const second = yield* startKeys;
        yield* test.type("q");

        expect(yield* Fiber.join(second)).toBe("stopped");
      }),
    ),
  );

  it.effect("lets a run start after a defect during the previous one's startup", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;

        const failed = yield* Effect.exit(run(underivableModel));
        expect(Exit.hasDies(failed)).toBe(true);

        yield* written.discard;
        const second = yield* run(keyProgram()).pipe(Effect.forkScoped({ startImmediately: true }));
        // A run refused as busy never draws, so its exit stands in for the first frame.
        yield* Effect.raceFirst(written.next, Fiber.await(second));
        yield* test.type("q");
        expect(yield* Fiber.join(second)).toBe("stopped");
      }),
    ),
  );
});
