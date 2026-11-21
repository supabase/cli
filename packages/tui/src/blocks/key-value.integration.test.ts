import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { column, row, text, widestLine } from "../view/public.ts";
import type { Node } from "../view/public.ts";
import * as KeyValue from "./key-value.ts";
import { render as renderNode } from "./test-support.ts";

/** Renders `node` on a terminal `columns` wide; the live region is one column narrower. */
const render = (node: Node, columns: number) => renderNode(node, { columns, rows: 24 });

/** Renders `node` in exactly `columns` cells and returns each row as text. */
const frame = (node: Node, columns: number) =>
  Effect.map(render(node, columns + 1), ({ lines }) => lines);

const entries = [
  { key: "name", value: "Acme" },
  { key: "region", value: "eu-west-1" },
  { key: "id", value: "abc" },
];

describe("KeyValue", () => {
  it.effect("aligns every value to the widest key", () =>
    Effect.gen(function* () {
      const { lines } = yield* render(KeyValue.view({ entries }), 40);

      expect(lines).toEqual(["name   Acme", "region eu-west-1", "id     abc"]);
    }),
  );

  it.effect("caps the key column so a long key cannot hide the values", () =>
    Effect.gen(function* () {
      const { lines } = yield* render(
        KeyValue.view({
          entries: [
            { key: "Database connection string (pooler)", value: "postgres://pooler" },
            { key: "Region", value: "eu-west-1" },
          ],
        }),
        40,
      );

      expect(lines).toEqual([
        "Database connection  postgres://pooler",
        "string (pooler)",
        "Region               eu-west-1",
      ]);
    }),
  );

  it.effect("sizes the key column by the rendered width of a key with a tab", () =>
    Effect.gen(function* () {
      const { lines } = yield* render(
        KeyValue.view({ entries: [{ key: "API\tURL", value: "https://x.test" }] }),
        80,
      );

      expect(lines).toEqual(["API     URL https://x.test"]);
    }),
  );

  it.effect("keeps long keys that differ only at the end distinguishable", () =>
    Effect.gen(function* () {
      const { lines } = yield* render(
        KeyValue.view({
          entries: [
            { key: "Database connection string (direct)", value: "postgres://direct" },
            { key: "Database connection string (pooler)", value: "postgres://pooler" },
          ],
        }),
        80,
      );

      expect(lines.join("\n")).toContain("string (direct)");
      expect(lines.join("\n")).toContain("string (pooler)");
    }),
  );

  it.effect("leaves room for the value beside a long key on a narrow terminal", () =>
    Effect.gen(function* () {
      const { lines } = yield* render(
        KeyValue.view({
          entries: [
            { key: "Database connection string (pooler)", value: "postgres://pooler" },
            { key: "Region", value: "eu-west-1" },
          ],
        }),
        26,
      );

      expect(lines.find((line) => line.startsWith("Region"))).toContain("eu-west-1");
    }),
  );

  it.effect("wraps a long value inside the value column", () =>
    Effect.gen(function* () {
      const { lines } = yield* render(
        KeyValue.view({
          entries: [{ key: "description", value: "alpha beta gamma delta epsilon zeta" }],
        }),
        25,
      );

      expect(lines).toEqual([
        "description alpha beta",
        "            gamma delta",
        "            epsilon zeta",
      ]);
    }),
  );

  it.effect("breaks an unbreakable value instead of overflowing the width", () =>
    Effect.gen(function* () {
      const { lines } = yield* render(
        KeyValue.view({ entries: [{ key: "id", value: "x".repeat(30) }] }),
        13,
      );

      expect(lines).toEqual(["id xxxxxxxxx", "   xxxxxxxxx", "   xxxxxxxxx", "   xxx"]);
    }),
  );

  it.effect("puts a gutter glyph before each entry when given a tone", () =>
    Effect.gen(function* () {
      const { lines } = yield* render(KeyValue.view({ entries, tone: "success" }), 40);

      expect(lines).toEqual(["• name   Acme", "• region eu-west-1", "• id     abc"]);
    }),
  );

  it.effect("colors only the gutter glyph and keeps keys and values in the default color", () =>
    Effect.gen(function* () {
      const { bytes } = yield* render(KeyValue.view({ entries, tone: "success" }), 40);

      const colored = bytes.split("\u001b[").filter((chunk) => /^[\d;]*38;/.test(chunk));
      expect(colored).toEqual(["38;5;78m•", "38;5;78m•", "38;5;78m•"]);
      expect(bytes).toContain("\u001b[1mname");
    }),
  );

  it.effect("draws nothing for no entries", () =>
    Effect.gen(function* () {
      const { lines } = yield* render(KeyValue.view({ entries: [] }), 40);

      expect(lines).toEqual([]);
    }),
  );

  describe("layout", () => {
    const pooler = { key: "Database connection string (pooler)", value: "postgres://pooler" };

    it.effect("halves a 26-cell block into a 13-cell key column and wraps both columns", () =>
      Effect.gen(function* () {
        const rows = yield* frame(
          KeyValue.view({ entries: [{ key: "Connection string", value: "alpha beta gamma" }] }),
          26,
        );

        expect(rows).toEqual(["Connection    alpha beta", "string        gamma"]);
      }),
    );

    it.effect("keeps one value start column when a wrapped value sits among short ones", () =>
      Effect.gen(function* () {
        const rows = yield* frame(
          column(
            [
              KeyValue.view({
                entries: [
                  { key: "name", value: "Acme" },
                  { key: "description", value: "alpha beta gamma delta epsilon" },
                  { key: "id", value: "abc" },
                ],
              }),
            ],
            { width: 30 },
          ),
          80,
        );

        expect(rows).toEqual([
          "name        Acme",
          "description alpha beta gamma",
          "            delta epsilon",
          "id          abc",
        ]);
      }),
    );

    it.effect("resolves the key percentage against a nested block, not the terminal", () =>
      Effect.gen(function* () {
        const rows = yield* frame(
          row([
            column([KeyValue.view({ entries: [pooler, { key: "Region", value: "eu-west-1" }] })], {
              width: 26,
              shrink: 0,
            }),
          ]),
          80,
        );

        expect(rows.find((line) => line.startsWith("Region"))).toBe("Region        eu-west-1");
      }),
    );

    it.effect("shows the whole value and a status label beside an auto-width block", () =>
      Effect.gen(function* () {
        const rows = yield* frame(
          column([
            row(
              [
                KeyValue.view({ entries: [{ key: "API URL", value: "http://127.0.0.1:54321" }] }),
                text("healthy"),
              ],
              { gap: 2 },
            ),
            text("below"),
          ]),
          80,
        );

        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatch(/^API URL http:\/\/127\.0\.0\.1:54321 +healthy$/);
        expect(rows[1]).toBe("below");
      }),
    );

    it.effect("adds exactly one gap around an empty block between two children", () =>
      Effect.gen(function* () {
        const rows = yield* frame(
          column([text("above"), KeyValue.view({ entries: [] }), text("below")], { gap: 1 }),
          20,
        );

        expect(rows).toEqual(["above", "", "below"]);
      }),
    );

    for (const [columns, first] of [
      [80, "Database connection      postgres://pooler"],
      [40, "Database connection  postgres://pooler"],
    ] as const) {
      it.effect(
        `wraps a long key in an align: start column at ${columns} cells because the block stretches itself`,
        () =>
          Effect.gen(function* () {
            const rows = yield* frame(
              column([KeyValue.view({ entries: [pooler] }), text("next")], { align: "start" }),
              columns,
            );

            expect(rows).toEqual([first, "string (pooler)", "next"]);
          }),
      );
    }

    it.effect("reflows inside a responsive bordered panel and keeps its right border", () =>
      Effect.gen(function* () {
        const panel = column(
          [KeyValue.view({ entries: [pooler, { key: "Region", value: "eu-west-1" }] })],
          {
            width: "100%",
            maxWidth: 80,
            border: "single",
            padding: { x: 1 },
          },
        );

        const narrow = yield* frame(panel, 40);
        const wide = yield* frame(panel, 100);

        expect(narrow).toEqual([
          `┌${"─".repeat(38)}┐`,
          "│ Database           postgres://pooler │",
          "│ connection string                    │",
          "│ (pooler)                             │",
          "│ Region             eu-west-1         │",
          `└${"─".repeat(38)}┘`,
        ]);
        expect(wide.map(widestLine)).toEqual(Array.from({ length: wide.length }, () => 80));
        expect(wide[1]).toContain("Database connection      postgres://pooler");
      }),
    );
  });
});
