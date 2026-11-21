import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { test } from "vitest";

import type { ColorLevel } from "../capabilities.ts";
import { defaultTheme } from "../theme/theme.ts";
import type { ThemeSpec } from "../theme/theme.ts";
import * as Engine from "./engine.ts";
import { layout } from "./layout.ts";
import type { Line } from "./layout.ts";
import { paint } from "./paint.ts";
import * as View from "./view.ts";

const theme: ThemeSpec = {
  tones: { ...defaultTheme.tones, accent: { hex: "#3ECF8E", ansi256: 78, ansi16: "green" } },
};
const terminalTheme = defaultTheme;

const SGR = new RegExp(String.raw`\u001b\[[0-9;]*m`, "gu");

const accentBold: Line = [{ text: "ok", tone: "accent", emphasis: "bold" }];

describe("paint", () => {
  test("emits no ESC bytes when styling is not allowed", () => {
    const line: Line = [
      { text: "a", tone: "danger", emphasis: "bold" },
      { text: "b", tone: "muted" },
      { text: "c", emphasis: "underline" },
    ];
    expect(paint(line, { isStyled: false, colorLevel: 0, theme })).toBe("abc");
  });

  test("keeps emphasis but drops tone colors at color level 0", () => {
    const line: Line = [
      { text: "a", tone: "danger", emphasis: "bold" },
      { text: "b", tone: "muted" },
      { text: "c", emphasis: "underline" },
    ];
    expect(paint(line, { isStyled: true, colorLevel: 0, theme })).toBe(
      "\u001b[1ma\u001b[0mb\u001b[4mc\u001b[0m",
    );
  });

  test.each([
    [1, "\u001b[1;32mok\u001b[0m"],
    [2, "\u001b[1;38;5;78mok\u001b[0m"],
    [3, "\u001b[1;38;2;62;207;142mok\u001b[0m"],
  ] as const)(
    "picks the color form for level %i and resets after the segment",
    (colorLevel, expected) => {
      expect(paint(accentBold, { isStyled: true, colorLevel, theme })).toBe(expected);
    },
  );

  test.each([1, 2, 3] as const)(
    "a terminal-palette tone is a basic 16-color code at level %i",
    (colorLevel) => {
      const line: Line = [
        { text: "a", tone: "accent" },
        { text: "m", tone: "muted" },
      ];
      expect(paint(line, { isStyled: true, colorLevel, theme: terminalTheme })).toBe(
        "\u001b[36ma\u001b[0m\u001b[90mm\u001b[0m",
      );
    },
  );

  test("uses bright 16-color codes for muted text", () => {
    expect(paint([{ text: "m", tone: "muted" }], { isStyled: true, colorLevel: 1, theme })).toBe(
      "\u001b[90mm\u001b[0m",
    );
  });

  test.each([
    ["bold", 1],
    ["dim", 2],
    ["italic", 3],
    ["underline", 4],
    ["inverse", 7],
  ] as const)("writes %s as SGR %i alone when the tone is default", (emphasis, code) => {
    expect(paint([{ text: "x", emphasis }], { isStyled: true, colorLevel: 3, theme })).toBe(
      `\u001b[${code}mx\u001b[0m`,
    );
  });

  test("leaves unstyled segments bare at every color level", () => {
    for (const colorLevel of [0, 1, 2, 3] as const) {
      expect(
        paint([{ text: "plain" }, { text: "x", tone: "default" }], {
          isStyled: true,
          colorLevel,
          theme,
        }),
      ).toBe("plainx");
    }
  });
});

describe("layout output through paint", () => {
  const node = View.column([
    View.text([
      View.glyph({ unicode: "✔", ascii: "+" }, { tone: "success" }),
      View.span(" ready", { emphasis: "bold" }),
    ]),
    View.column([View.text("body", { tone: "muted" })], { border: { tone: "accent" } }),
  ]);

  for (const colorLevel of [0, 1, 2, 3] as const satisfies ReadonlyArray<ColorLevel>) {
    it.effect(`level ${colorLevel} writes SGR only, never cursor sequences`, () =>
      Effect.gen(function* () {
        const engine = yield* Engine.load;
        const output = layout(node, { columns: 30, unicode: true, engine })
          .map((line) => paint(line, { isStyled: colorLevel !== 0, colorLevel, theme }))
          .join("\n");
        const withoutSgr = output.replace(SGR, "");
        expect(withoutSgr).not.toContain("\u001b");
        if (colorLevel === 0) expect(output).not.toContain("\u001b");
        else expect(output).toContain("\u001b[");
      }),
    );
  }

  it.effect("an ASCII terminal gets only ASCII glyphs", () =>
    Effect.gen(function* () {
      const engine = yield* Engine.load;
      const output = layout(node, { columns: 30, unicode: false, engine })
        .map((line) => paint(line, { isStyled: false, colorLevel: 0, theme }))
        .join("\n");
      expect(output).toBe(
        ["+ ready", `+${"-".repeat(28)}+`, `|${"body".padEnd(28)}|`, `+${"-".repeat(28)}+`].join(
          "\n",
        ),
      );
      expect(output).toMatch(/^[ -~\n]*$/u);
    }),
  );
});
