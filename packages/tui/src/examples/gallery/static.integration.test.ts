import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { run } from "../../runtime/public.ts";
import { dropTrailingBlank, withTerminal } from "../../runtime/test-support.ts";
import { TestTerminal } from "../../terminal/testing.ts";
import { widestLine } from "../../view/public.ts";
import { staticProgram } from "./static.ts";

describe("gallery static screen", () => {
  it.effect("lands every block in scrollback and returns", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;

        yield* run(staticProgram);

        const lines = dropTrailingBlank(yield* test.scrollback);
        expect(lines).toEqual(
          expect.arrayContaining([
            "Spinner, stopped",
            "✔ Migrations applied",
            "✖ Functions failed to deploy",
            "▲ Storage needs attention",
            "Spinner, running",
            "Select, active",
            "Select, submitted",
            "KeyValue",
          ]),
        );
        expect(lines).toContain("◇ Which region?");
        expect(lines).toContain("│ West EU (Ireland)");
        expect(lines).toContainEqual(expect.stringMatching(/^│ Region {2}eu-west-1 +│$/));
      }),
    ),
  );

  it.effect("reflows the KeyValue panel to a narrow terminal and keeps its borders", () =>
    withTerminal(
      Effect.gen(function* () {
        const test = yield* TestTerminal;

        yield* run(staticProgram);

        const lines = dropTrailingBlank(yield* test.scrollback);
        const top = lines.findIndex((line) => line.startsWith("╭"));
        const bottom = lines.findIndex((line) => line.startsWith("╰"));
        const panel = lines.slice(top, bottom + 1);
        expect(panel.length).toBeGreaterThan(4);
        expect(panel.map(widestLine)).toEqual(panel.map(() => 29));
        expect(panel.slice(1, -1).every((line) => line.endsWith("│"))).toBe(true);
      }),
      { columns: 30, rows: 60 },
    ),
  );
});
