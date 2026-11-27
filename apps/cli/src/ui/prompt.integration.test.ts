import { describe, expect, it } from "@effect/vitest";
import { TerminalTest } from "@supabase/ui-terminal/testing";
import { Effect, Fiber } from "effect";

import { select } from "./prompt.ts";

const regions = {
  message: "Which region?",
  options: [
    { value: "us-east-1", label: "East US (N. Virginia)", hint: "closest" },
    { value: "eu-west-1", label: "West EU (Ireland)" },
  ],
} as const;

const showing = (text: string) => (rows: ReadonlyArray<string>) =>
  rows.some((row) => row.includes(text));

describe("ui prompt", () => {
  it.effect(
    "select resolves with the chosen value and leaves the submitted state above the cursor",
    () =>
      TerminalTest.withTestTerminal({ columns: 60, rows: 10 }, (t) =>
        Effect.gen(function* () {
          t.terminal.write("$ supabase init\r\n");
          const fiber = yield* TerminalTest.startOn(t, select(regions));
          const listed = yield* t.untilScreen(showing("● East US"));
          expect(listed.slice(1, 4)).toEqual([
            "◆ Which region?",
            "│ ● East US (N. Virginia) (closest)",
            "│ ○ West EU (Ireland)",
          ]);

          yield* t.type("\u001b[B");
          yield* t.untilScreen(showing("● West EU"));
          yield* t.type("\r");

          expect(yield* Fiber.join(fiber)).toBe("eu-west-1");
          expect((yield* t.scrollback).slice(0, 3)).toEqual([
            "$ supabase init",
            "◇ Which region?",
            "│ West EU (Ireland)",
          ]);
          expect(yield* t.cursor).toEqual({ x: 0, y: 3 });
        }),
      ),
  );

  it.effect("select starts on the `initial` option", () =>
    TerminalTest.withTestTerminal({ columns: 60, rows: 10 }, (t) =>
      Effect.gen(function* () {
        const fiber = yield* TerminalTest.startOn(t, select({ ...regions, initial: "eu-west-1" }));
        yield* t.untilScreen(showing("● West EU"));
        yield* t.type("\r");
        expect(yield* Fiber.join(fiber)).toBe("eu-west-1");
      }),
    ),
  );
});
