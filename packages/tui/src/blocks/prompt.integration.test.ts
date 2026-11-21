import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import { TestClock } from "effect/testing";

import {
  dropTrailingBlank,
  expectCursorVisible,
  nextFrame,
  shown,
  withTerminal,
  Written,
} from "../runtime/test-support.ts";
import { TestTerminal } from "../terminal/testing.ts";
import * as Prompt from "./prompt.ts";

const options: NonEmptyReadonlyArray<{ value: number; label: string; hint?: string }> = [
  { value: 10, label: "Ten" },
  { value: 20, label: "Twenty", hint: "middle" },
  { value: 30, label: "Thirty" },
];

const pick = (initial?: number) =>
  Prompt.select({
    message: "Pick a number",
    options,
    ...(initial === undefined ? {} : { initial }),
  });

const expectRestored = Effect.gen(function* () {
  const test = yield* TestTerminal;
  expect(yield* test.inputState).toEqual({ paused: true, raw: false, listenerCount: 0 });
  expect(yield* test.rawModeTransitions).toEqual([true, false]);
});

const start = (initial?: number) =>
  Effect.gen(function* () {
    const written = yield* Written;
    const running = yield* pick(initial).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* written.next;
    return running;
  });

const startWith = <A>(config: Prompt.SelectConfig<A>) =>
  Effect.gen(function* () {
    const written = yield* Written;
    const running = yield* Prompt.select(config).pipe(
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* written.next;
    return running;
  });

const numbered = Array.from({ length: 10 }, (_, index) => ({
  value: index,
  label: `Option ${index}`,
}));

describe("Prompt.select", () => {
  it.effect("keeps the highlighted option on a two-row terminal", () =>
    withTerminal(
      Effect.gen(function* () {
        yield* startWith({
          message: "Pick",
          options: [{ value: 0, label: "Option 0" }, ...numbered.slice(1)],
          initial: 7,
        });

        expect(yield* shown).toContain("│ ● Option 7");
      }),
      { rows: 2 },
    ),
  );

  it.effect("keeps header and footer around rows - 2 options from three rows up", () =>
    withTerminal(
      Effect.gen(function* () {
        yield* startWith({
          message: "Pick",
          options: [{ value: 0, label: "Option 0" }, ...numbered.slice(1)],
          initial: 7,
        });

        expect(yield* shown).toEqual(["◆ Pick", "│ ● Option 7", "└"]);
      }),
      { rows: 4 },
    ),
  );

  it.effect("fits a long message to one row so the question and the highlight stay on screen", () =>
    withTerminal(
      Effect.gen(function* () {
        yield* startWith({
          message: "Pick the organization for this project",
          options: [{ value: 0, label: "Option 0" }, ...numbered.slice(1)],
          initial: 7,
        });

        const lines = yield* shown;
        expect(lines[0]).toMatch(/^◆ Pick the organization/);
        expect(lines).toContain("│ ● Option 7");
      }),
      { columns: 40, rows: 4 },
    ),
  );

  it("rejects an empty options list at compile time", () => {
    // @ts-expect-error -- `options` must be a non-empty array
    void Prompt.select({ message: "Pick", options: [] });
  });

  it.effect("truncates a multiline label to one row", () =>
    withTerminal(
      Effect.gen(function* () {
        yield* startWith({
          message: "Pick",
          options: [
            { value: 1, label: "First line\nsecond line that is far too long to fit" },
            { value: 2, label: "Other" },
          ],
        });

        expect(yield* shown).toEqual([
          "◆ Pick",
          "│ ● First line second line tha…",
          "│ ○ Other",
          "└",
        ]);
      }),
      { columns: 32 },
    ),
  );

  it.effect(
    "highlights the first option when `initial` is omitted, even if a later value is undefined",
    () =>
      withTerminal(
        Effect.gen(function* () {
          yield* startWith<number | undefined>({
            message: "Pick",
            options: [
              { value: 1, label: "One" },
              { value: undefined, label: "Skip" },
            ],
          });

          expect(yield* shown).toContain("│ ● One");
        }),
      ),
  );

  it.effect(
    "highlights the option whose value is undefined for an explicit `initial: undefined`",
    () =>
      withTerminal(
        Effect.gen(function* () {
          const test = yield* TestTerminal;
          const running = yield* startWith<number | undefined>({
            message: "Pick",
            options: [
              { value: 1, label: "One" },
              { value: undefined, label: "Skip" },
            ],
            initial: undefined,
          });
          expect(yield* shown).toContain("│ ● Skip");

          yield* test.type("\r");

          expect(yield* Fiber.join(running)).toBeUndefined();
        }),
      ),
  );

  it.effect("returns the value of the option chosen with arrows and Enter", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const running = yield* start();
        expect(yield* shown).toEqual([
          "◆ Pick a number",
          "│ ● Ten",
          "│ ○ Twenty (middle)",
          "│ ○ Thirty",
          "└",
        ]);

        yield* test.type("\x1b[B");
        yield* nextFrame;
        expect(yield* shown).toContain("│ ● Twenty (middle)");

        yield* test.type("\x1b[B");
        yield* nextFrame;
        yield* test.type("\r");

        expect(yield* Fiber.join(running)).toBe(30);
        expect(dropTrailingBlank(yield* test.scrollback)).toEqual(["◇ Pick a number", "│ Thirty"]);
        yield* expectRestored;
        yield* expectCursorVisible;
      }),
    ),
  );

  it.effect("highlights the option matching `initial`", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const running = yield* start(20);
        expect(yield* shown).toContain("│ ● Twenty (middle)");

        yield* test.type("\r");

        expect(yield* Fiber.join(running)).toBe(20);
      }),
    ),
  );

  it.effect("highlights the first option when `initial` is not among the options", () =>
    withTerminal(
      Effect.gen(function* () {
        yield* start(99);

        expect(yield* shown).toContain("│ ● Ten");
      }),
    ),
  );

  it.effect("interrupts on Escape and restores the terminal", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const running = yield* start();

        yield* test.type("\x1b");
        yield* TestClock.adjust("50 millis");

        expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
        yield* expectRestored;
        yield* expectCursorVisible;
      }),
    ),
  );

  it.effect.each([
    { name: "input is not a TTY", terminal: { inputIsTTY: false } },
    { name: "output is not a TTY", terminal: { isTTY: false } },
  ])("fails with NonInteractive without writing when $name", ({ terminal }) =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;

        const error = yield* Effect.flip(pick());

        expect(error).toBeInstanceOf(Prompt.NonInteractive);
        expect(yield* test.rawBytes).toBe("");
        expect(yield* test.rawModeTransitions).toEqual([]);
      }),
      terminal,
    ),
  );
});
