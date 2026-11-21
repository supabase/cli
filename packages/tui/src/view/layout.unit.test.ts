import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import * as Engine from "./engine.ts";
import { layout } from "./layout.ts";
import type { Node } from "./node.ts";
import * as View from "./view.ts";
import { width } from "./width.ts";

const unicode = true;
const ascii = false;

const tick = { unicode: "✔", ascii: "+" };

const rendering = Effect.map(Engine.load, (engine) => ({
  lines: (node: Node, columns: number, supportsUnicode = unicode) =>
    layout(node, { columns, unicode: supportsUnicode, engine }),
  render: (node: Node, columns: number, supportsUnicode = unicode): ReadonlyArray<string> =>
    layout(node, { columns, unicode: supportsUnicode, engine }).map((line) =>
      line.map((segment) => segment.text).join(""),
    ),
}));

const labeled = (text: string, options: View.BoxOptions = {}) =>
  View.column([View.text(text, { wrap: false })], options);

describe("text layout", () => {
  for (const [name, content, columns, expected] of [
    ["wraps at spaces", "the quick brown fox", 10, ["the quick", "brown fox"]],
    ["fits exactly", "abcde", 5, ["abcde"]],
    ["breaks a long word at grapheme boundaries", "abcdefghij", 4, ["abcd", "efgh", "ij"]],
    ["moves a long word to its own line first", "ab abcdefgh", 5, ["ab", "abcde", "fgh"]],
    ["drops spaces at a wrap point", "aaa   bbb", 4, ["aaa", "bbb"]],
    ["keeps first-line indentation", "  ab cd", 5, ["  ab", "cd"]],
    ["keeps trailing spaces at the end of a hard line", "ab  \ncd ", 10, ["ab  ", "cd "]],
    ["keeps blank lines from LF", "a\n\nb", 10, ["a", "", "b"]],
    ["wraps wide characters by cells", "漢字漢字漢", 5, ["漢字", "漢字", "漢"]],
    ["drops a character wider than the line", "a漢b", 1, ["a", "b"]],
  ] as const) {
    it.effect(name, () =>
      Effect.gen(function* () {
        const { render } = yield* rendering;
        expect(render(View.text(content), columns)).toEqual(expected);
      }),
    );
  }

  for (const [name, supportsUnicode, content, columns, expected] of [
    ["unicode ellipsis", unicode, "hello world", 8, ["hello w…"]],
    ["ASCII ellipsis", ascii, "hello world", 8, ["hello..."]],
    ["no ellipsis when the text fits", unicode, "hello", 5, ["hello"]],
    ["wide characters never overflow the budget", unicode, "漢字漢字", 4, ["漢…"]],
    ["each hard line truncates separately", unicode, "abcdef\nxy", 4, ["abc…", "xy"]],
    ["ellipsis too wide to fit is omitted", ascii, "abcdef", 2, ["ab"]],
  ] as const) {
    it.effect(`truncates when not wrapping: ${name}`, () =>
      Effect.gen(function* () {
        const { render } = yield* rendering;
        expect(render(View.text(content, { wrap: false }), columns, supportsUnicode)).toEqual(
          expected,
        );
      }),
    );
  }

  it.effect("keeps the style of the text an ellipsis replaces", () =>
    Effect.gen(function* () {
      const { lines } = yield* rendering;
      const [line] = lines(View.text("hello world", { wrap: false, tone: "danger" }), 8);
      expect(line).toEqual([{ text: "hello w…", tone: "danger" }]);
    }),
  );

  it.effect("resolves a glyph for the terminal's repertoire before measuring", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const radio = { unicode: "●", ascii: ">" };
      const node = View.text([View.glyph(radio), View.span("abc")], { wrap: false });
      expect(render(node, 5, unicode)).toEqual(["●abc"]);
      expect(render(node, 5, ascii)).toEqual([">abc"]);
    }),
  );

  it.effect("measures a wide glyph by its cells and normalizes it like text", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const wide = View.text(
        [View.glyph({ unicode: "漢", ascii: "\u001b[31mx" }), View.span("a")],
        {
          wrap: false,
        },
      );
      expect(render(wide, 2, unicode)).toEqual(["…"]);
      expect(render(wide, 3, unicode)).toEqual(["漢a"]);
      expect(render(wide, 3, ascii)).toEqual(["xa"]);
    }),
  );

  it.effect("normalizes untrusted text before measuring", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const node = View.text("\u001b[31mred\u001b[0m\ta\u0007b\r\nnext");
      expect(render(node, 40)).toEqual([`red${" ".repeat(5)}a�b`, "next"]);
    }),
  );

  it.effect("never splits a grapheme across span boundaries when wrapping", () =>
    Effect.gen(function* () {
      const { lines } = yield* rendering;
      const node = View.text([
        View.span("e", { tone: "accent" }),
        View.span("\u0301x", { tone: "muted" }),
      ]);
      expect(lines(node, 1)).toEqual([
        [{ text: "e\u0301", tone: "accent" }],
        [{ text: "x", tone: "muted" }],
      ]);
    }),
  );

  it.effect("never splits a ZWJ sequence across span boundaries when truncating", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const node = View.text(["ab", View.span("👩"), View.span("‍💻")], { wrap: false });
      expect(render(node, 4)).toEqual(["ab…"]);
      expect(render(node, 6)).toEqual(["ab👩‍💻"]);
    }),
  );

  it.effect("renders an empty text as one blank line and an empty node as nothing", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      expect(render(View.text(""), 10)).toEqual([""]);
      expect(render(View.empty, 10)).toEqual([]);
    }),
  );

  it.effect("keeps every line of text that a wider sibling squeezes", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const node = View.row([
        View.text(`${"w".repeat(40)} tail`),
        View.column([View.text("fixed")], { width: 10, shrink: 0 }),
      ]);
      expect(render(node, 30)).toEqual(["w".repeat(20) + "fixed", "w".repeat(20), "tail"]);
    }),
  );
});

describe("wide grapheme fixtures", () => {
  const keycaps = "abcdefg1️⃣1️⃣";
  const zwjPair = "abcdefg👩‍💻👩‍💻";

  for (const [name, text, cells, wrapped] of [
    ["two keycaps", keycaps, 11, ["abcdefg1️⃣", "1️⃣"]],
    ["two ZWJ pairs", zwjPair, 15, ["abcdefg", "👩‍💻👩‍💻"]],
  ] as const) {
    it.effect(
      `${name} fit one line at their measured width and wrap whole graphemes below it`,
      () =>
        Effect.gen(function* () {
          const { render } = yield* rendering;
          expect(width(text)).toBe(cells);
          expect(render(View.text(text), cells)).toEqual([text]);
          expect(render(View.text(text), 10)).toEqual(wrapped);
        }),
    );
  }

  it.effect("truncating keeps whole graphemes and fits", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      expect(render(View.text(keycaps, { wrap: false }), 10)).toEqual(["abcdefg1️⃣…"]);
      expect(render(View.text(zwjPair, { wrap: false }), 10)).toEqual(["abcdefg…"]);
    }),
  );
});

describe("box layout", () => {
  it.effect("a column stacks children with a gap", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const node = View.column([View.text("a"), View.text("b")], { gap: 1 });
      expect(render(node, 10)).toEqual(["a", "", "b"]);
    }),
  );

  it.effect("an empty child between gapped children adds no row", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const node = View.column([View.text("a"), View.empty, View.text("b")], { gap: 1 });
      expect(render(node, 10)).toEqual(["a", "", "b"]);
    }),
  );

  it.effect("padding adds blank lines and indentation", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const node = View.column([View.text("hi")], { padding: { x: 2, y: 1 } });
      expect(render(node, 10)).toEqual(["", "  hi", ""]);
    }),
  );

  it.effect("padding sides override their axis", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const node = View.column([View.text("hi")], { padding: { y: 1, left: 3, bottom: 0 } });
      expect(render(node, 10)).toEqual(["", "   hi"]);
    }),
  );

  for (const [name, options, supportsUnicode, expected] of [
    ["single", { border: "single" as const }, unicode, ["┌────┐", "│ hi │", "└────┘"]],
    ["rounded", { border: "rounded" as const }, unicode, ["╭────╮", "│ hi │", "╰────╯"]],
    ["ASCII fallback", { border: "single" as const }, ascii, ["+----+", "| hi |", "+----+"]],
  ] as const) {
    it.effect(`border ${name} wraps its content and padding`, () =>
      Effect.gen(function* () {
        const { render } = yield* rendering;
        const node = View.column([View.text("hi")], {
          ...options,
          alignSelf: "start",
          padding: { x: 1 },
        });
        expect(render(node, 20, supportsUnicode)).toEqual(expected);
      }),
    );
  }

  it.effect("border segments carry the border tone", () =>
    Effect.gen(function* () {
      const { lines } = yield* rendering;
      const node = View.column([View.text("hi")], {
        border: { tone: "accent" },
        alignSelf: "start",
      });
      const [top] = lines(node, 20);
      expect(top).toEqual([{ text: "┌──┐", tone: "accent" }]);
    }),
  );

  it.effect("border and padding together stack: border outside, padding inside", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const node = View.column([View.text("hi")], {
        border: "single",
        padding: { x: 2, y: 1 },
        alignSelf: "start",
      });
      expect(render(node, 20)).toEqual([
        "┌──────┐",
        "│      │",
        "│  hi  │",
        "│      │",
        "└──────┘",
      ]);
    }),
  );

  it.effect("an inverse label keeps its trailing space beside the next cell", () =>
    Effect.gen(function* () {
      const { lines } = yield* rendering;
      const node = View.row([View.text(" ok ", { emphasis: "inverse" }), View.text("x")]);
      expect(lines(node, 10)).toEqual([[{ text: " ok ", emphasis: "inverse" }, { text: "x" }]]);
    }),
  );
});

describe("flex layout", () => {
  it.effect("space-between puts the leftover space between children", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const node = View.row([View.text("a"), View.text("b"), View.text("c")], {
        justify: "space-between",
      });
      expect(render(node, 11)).toEqual(["a    b    c"]);
    }),
  );

  it.effect("a spacer pushes a status to the right edge", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const node = View.row([View.text("deploy"), View.spacer(), View.text("ok")]);
      expect(render(node, 20)).toEqual(["deploy            ok"]);
    }),
  );

  it.effect("grow children share the remainder equally", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const node = View.row([
        View.column([View.text("a")], { grow: 1, basis: 0 }),
        View.column([View.text("b")], { grow: 1, basis: 0 }),
      ]);
      expect(render(node, 6)).toEqual(["a  b"]);
    }),
  );

  it.effect("a shrink 0 child keeps its width and the grower takes what is left", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const node = View.row([
        View.column([View.text("abcdef", { wrap: false })], { width: 4, shrink: 0 }),
        View.column([View.text("x")], { grow: 1 }),
      ]);
      expect(render(node, 10)).toEqual(["abc…x"]);
    }),
  );

  it.effect("align places children on the cross axis and alignSelf overrides it", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const node = View.column(
        [
          View.text("a"),
          View.column([View.text("b")], { alignSelf: "end" }),
          View.column([View.text("c")], { alignSelf: "stretch" }),
        ],
        { align: "center", width: 5 },
      );
      expect(render(node, 5)).toEqual(["  a", "    b", "c"]);
    }),
  );

  it.effect("wrap: true flows chips onto new lines", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const chips = ["[one]", "[two]", "[three]", "[four]"].map((chip) => View.text(chip));
      expect(render(View.row(chips, { wrap: true, gap: 1 }), 14)).toEqual([
        "[one] [two]",
        "",
        "[three] [four]",
      ]);
    }),
  );

  it.effect(
    "a width: 100% panel with a maxWidth reflows at 56 cells and keeps its right border",
    () =>
      Effect.gen(function* () {
        const { render } = yield* rendering;
        const text =
          "a panel that stays within eighty cells but narrows to the pane when the terminal is smaller than that";
        const panel = View.column([View.text(text)], {
          width: "100%",
          maxWidth: 80,
          border: "single",
          padding: { x: 1 },
        });
        const rows = render(panel, 56);
        const inner = (line: string) => `│ ${line.padEnd(52)} │`;
        expect(rows).toEqual([
          `┌${"─".repeat(54)}┐`,
          inner("a panel that stays within eighty cells but narrows"),
          inner("to the pane when the terminal is smaller than that"),
          `└${"─".repeat(54)}┘`,
        ]);
        expect(render(panel, 100).map(width)).toEqual([80, 80, 80, 80]);
      }),
  );

  it.effect("a 50% width at an odd width wraps at the floor, so the next block stays aligned", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const indented = `\t${"a".repeat(15)} ${"b".repeat(15)}`;
      const node = View.column([
        View.row([View.column([View.text(indented)], { width: "50%" }), View.text("X")]),
        View.text("next"),
      ]);
      expect(render(node, 77)).toEqual([
        `        ${"a".repeat(15)}${" ".repeat(16)}X`,
        "b".repeat(15),
        "next",
      ]);
    }),
  );

  it.effect("four equal text leaves in 55 cells keep all their text at fractional starts", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const leaves = ["a", "b", "c", "d"].map((letter) => View.text(letter.repeat(14)));
      expect(render(View.row(leaves), 55)).toEqual([
        `${"a".repeat(13)} ${"b".repeat(13)} ${"c".repeat(13)}${"d".repeat(13)}`,
        `a${" ".repeat(13)}b${" ".repeat(13)}c${" ".repeat(12)}d`,
      ]);
    }),
  );

  it.effect("six growing bordered cards in 77 cells share edges with no blank column", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const cards = Array.from({ length: 6 }, (_, index) =>
        View.column([View.text(`card ${index}`)], {
          grow: 1,
          border: "single",
          padding: { x: 1 },
        }),
      );
      const expected = (inner: ReadonlyArray<number>, body: (index: number) => string) => [
        inner.map((cells) => `┌${"─".repeat(cells)}┐`).join(""),
        inner.map((cells, index) => `│${` ${body(index)}`.padEnd(cells)}│`).join(""),
        inner.map((cells) => `└${"─".repeat(cells)}┘`).join(""),
      ];
      expect(render(View.row(cards), 77)).toEqual(
        expected([11, 11, 11, 10, 11, 11], (index) => `card ${index}`),
      );
    }),
  );

  it.effect("a height-constrained column clips wrapped text above a shrink 0 footer", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const node = View.column(
        [
          View.text("first line that is long enough to wrap onto several rows"),
          View.column([View.text("footer")], { shrink: 0 }),
        ],
        { width: 12, height: 3 },
      );
      expect(render(node, 40)).toEqual(["first line", "that is long", "footer"]);
    }),
  );

  it.effect("keeps the part of a trailing space run that fits", () =>
    Effect.gen(function* () {
      const { lines } = yield* rendering;
      expect(lines(View.text("OK  ", { emphasis: "inverse" }), 3)).toEqual([
        [{ text: "OK ", emphasis: "inverse" }],
      ]);
    }),
  );

  it.effect("a shrink 0 child wider than its border is clipped at the border", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const node = View.row([labeled("0123456789abcdef", { width: 16, shrink: 0 })], {
        border: "single",
      });
      expect(render(node, 10)).toEqual(["┌────────┐", "│01234567│", "└────────┘"]);
    }),
  );

  it.effect("a wide grapheme cut by a clip edge becomes a space and is never split", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const node = View.row([labeled("abc漢", { width: 5, shrink: 0 })], { border: "single" });
      expect(render(node, 6)).toEqual(["┌────┐", "│abc │", "└────┘"]);
    }),
  );
});

describe("narrow-width degradation", () => {
  const boxed = View.column([View.text("hello")], { border: "single", padding: 1 });

  it.effect("shows the box whole while it fits", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      expect(render(boxed, 9)).toEqual([
        "┌───────┐",
        "│       │",
        "│ hello │",
        "│       │",
        "└───────┘",
      ]);
    }),
  );

  it.effect("keeps only the cells that fit when border and padding use up the width", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      for (const columns of [4, 3, 2, 1]) {
        for (const row of render(boxed, columns)) {
          expect(width(row), `columns=${columns} row=${row}`).toBeLessThanOrEqual(columns);
        }
      }
      expect(render(boxed, 2)).toEqual(["┌─", "│", "│", "└─"]);
    }),
  );

  it.effect("clamps a shrink 0 child to what remains and clips the rest", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const fixed = (text: string) => View.column([View.text(text)], { width: 6, shrink: 0 });
      const node = View.row([fixed("aaaa"), fixed("bbbb")]);
      expect(render(node, 8)).toEqual(["aaaa  bb"]);
      expect(render(node, 6)).toEqual(["aaaa"]);
    }),
  );

  for (const columns of [0, -3, Number.NaN, 0.9]) {
    it.effect(`returns nothing at ${columns} columns without throwing`, () =>
      Effect.gen(function* () {
        const { render } = yield* rendering;
        expect(render(boxed, columns)).toEqual([]);
      }),
    );
  }

  it.effect("clamps negative and non-finite box numbers to 0", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const node = View.row([View.text("a"), View.text("b")], {
        gap: -2,
        padding: Number.NaN,
        grow: Number.NEGATIVE_INFINITY,
        shrink: -1,
        minWidth: -4,
      });
      expect(render(node, 10)).toEqual(["ab"]);
    }),
  );
});

describe("every line fits", () => {
  const tree = View.column(
    [
      View.row(
        [
          View.text([View.glyph(tick, { tone: "success" }), View.span(" done")], {
            wrap: false,
          }),
          View.column([View.text("漢字 mixed 1️⃣ 👩‍💻 wrapping text that is long")], { grow: 1 }),
          View.column([View.text("fixed-width cell", { wrap: false })], { width: 7, shrink: 0 }),
        ],
        { gap: 2 },
      ),
      View.column(
        [
          View.text("a\tb\nc é 😀 end", { emphasis: "bold" }),
          View.row(
            [
              View.column([View.text("left side text")], { grow: 1 }),
              View.spacer(),
              View.column([View.text("right side")], { grow: 1 }),
            ],
            { gap: 1 },
          ),
        ],
        { border: { style: "rounded", tone: "accent" }, padding: { x: 2, y: 1 }, gap: 1 },
      ),
    ],
    { gap: 1, padding: { x: 1 } },
  );

  for (const [name, supportsUnicode] of [
    ["unicode", unicode],
    ["ASCII", ascii],
  ] as const) {
    it.effect(`no line exceeds the columns at any width from 1 to 40 (${name})`, () =>
      Effect.gen(function* () {
        const { render } = yield* rendering;
        for (let columns = 1; columns <= 40; columns += 1) {
          for (const line of render(tree, columns, supportsUnicode)) {
            expect(width(line), `columns=${columns} line=${line}`).toBeLessThanOrEqual(columns);
          }
        }
      }),
    );
  }
});

describe("graphemes formed across row children", () => {
  it.effect("a keycap assembled from adjacent children never exceeds the budget", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const row = View.row([
        View.text("abcdef1", { wrap: false }),
        View.text("\u{FE0F}\u{20E3}1", { wrap: false }),
        View.text("\u{FE0F}\u{20E3}x", { wrap: false }),
      ]);

      const [line] = render(row, 9);

      expect(width(line ?? "")).toBeLessThanOrEqual(9);
    }),
  );

  it.effect("a nested row never exceeds its allocation, so its sibling survives", () =>
    Effect.gen(function* () {
      const { render } = yield* rendering;
      const nested = View.column(
        [
          View.row([
            View.text("1", { wrap: false }),
            View.text("\u{FE0F}\u{20E3}x", { wrap: false }),
          ]),
        ],
        { width: 2, shrink: 0 },
      );
      const row = View.row([nested, View.text("Z", { wrap: false })], { gap: 1 });

      const [line] = render(row, 4);

      expect(width(line ?? "")).toBeLessThanOrEqual(4);
      expect(line).toContain("Z");
    }),
  );

  it.effect(
    "box padding joined to a leading combining mark never overflows, so its sibling survives",
    () =>
      Effect.gen(function* () {
        const { render } = yield* rendering;
        const padded = View.column([View.text("\u{FE0F}\u{20E3}x", { wrap: false })], {
          padding: { x: 1 },
          width: 3,
          shrink: 0,
        });
        const row = View.row([padded, View.text("Z", { wrap: false })], { gap: 1 });

        const [line] = render(row, 5);

        expect(width(line ?? "")).toBeLessThanOrEqual(5);
        expect(line).toContain("Z");
      }),
  );

  it.effect(
    "a leading mark at the start of a leaf is shown as U+FFFD instead of joining the previous glyph",
    () =>
      Effect.gen(function* () {
        const { render } = yield* rendering;
        const row = View.row([
          View.text("1", { wrap: false }),
          View.text("\u{FE0F}\u{20E3}", { wrap: false }),
        ]);

        expect(render(row, 5)).toEqual(["1�"]);
      }),
  );
});
