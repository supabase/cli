import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";

import { run } from "../../runtime/public.ts";
import { nextFrame, shown, withTerminal, Written } from "../../runtime/test-support.ts";
import { TestTerminal } from "../../terminal/testing.ts";
import { program } from "./main.ts";

const hint = "up/down focus  left/right or -/+ change  a add  x remove  q quit";

describe("counters example", () => {
  it.effect("edits keyed rows through the focused counter and finishes with every count", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;
        const running = yield* run(program).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* written.next;
        expect(yield* shown).toEqual(["Counters (3)", "❯ count 0", "  count 0", "  count 0", hint]);

        for (const bytes of ["\x1b[B", "\x1b[C", "+"]) {
          yield* test.type(bytes);
          yield* nextFrame;
        }
        expect(yield* shown).toEqual(["Counters (3)", "  count 0", "❯ count 2", "  count 0", hint]);

        for (const bytes of ["a", "-"]) {
          yield* test.type(bytes);
          yield* nextFrame;
        }
        expect(yield* shown).toEqual([
          "Counters (4)",
          "  count 0",
          "  count 2",
          "  count 0",
          "❯ count -1",
          hint,
        ]);

        for (const bytes of ["\x1b[A", "x"]) {
          yield* test.type(bytes);
          yield* nextFrame;
        }
        expect(yield* shown).toEqual([
          "Counters (3)",
          "  count 0",
          "  count 2",
          "❯ count -1",
          hint,
        ]);

        yield* test.type("q");

        expect(yield* Fiber.join(running)).toEqual([0, 2, -1]);
      }),
    ),
  );

  it.effect("keeps the focused row on screen once the list outgrows the terminal", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;
        yield* run(program).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* written.next;

        for (const bytes of ["a", "a", "a", "+", "+"]) {
          yield* test.type(bytes);
          yield* nextFrame;
        }
        const grown = yield* shown;
        expect(grown).toContain("❯ count 2");
        expect(grown[0]).toBe("Counters (6)");
        expect(grown.at(-1)).toBe(hint);

        yield* test.type("\x1b[A");
        yield* nextFrame;
        expect((yield* shown).filter((line) => line.startsWith("❯"))).toEqual(["❯ count 0"]);
      }),
      { rows: 6 },
    ),
  );

  it.effect("keeps the focused row on screen on a narrow pane", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;
        yield* run(program).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* written.next;

        const initial = yield* shown;
        expect(initial).toContain("❯ count 0");
        expect(initial).toContain("^v<> a add x del q quit");

        for (const bytes of ["a", "a", "a", "+"]) {
          yield* test.type(bytes);
          yield* nextFrame;
        }

        const lines = yield* shown;
        expect(lines.length).toBeLessThanOrEqual(4);
        expect(lines).toContain("❯ count 1");
      }),
      { columns: 24, rows: 5 },
    ),
  );

  it.effect("draws the key help in the default color, not the muted one", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;
        const written = yield* Written;
        yield* run(program).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* written.next;

        const chunks = (yield* test.rawBytes).split("\u001b[");
        const help = chunks.find((chunk) => chunk.includes("up/down focus"));
        expect(help).toBeDefined();
        expect(help).not.toMatch(/^[\d;]*38;/);
      }),
    ),
  );
});
