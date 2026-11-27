import { describe, expect, it } from "@effect/vitest";
import { Terminal, TerminalHost } from "@supabase/ui-terminal";
import { TerminalTest } from "@supabase/ui-terminal/testing";
import { Effect, Fiber, Schema } from "effect";

import { KeyValue, Select, Spinner } from "./blocks.ts";

const showing = (text: string) => (rows: ReadonlyArray<string>) =>
  rows.some((row) => row.includes(text));

const Boxed = Terminal.component({
  name: "Boxed",
  model: Schema.Struct({}),
  message: Schema.Never,
}).make({
  init: () => ({}),
  update: ($) => $.model,
  view: (h) =>
    h.box.style({ border: "rounded", paddingX: 1 }).children(
      KeyValue(h, {
        unicode: true,
        tone: "accent",
        entries: [
          { key: "Name", value: "日本語のプロジェクト 🚀" },
          { key: "DB URL", value: "postgresql://127.0.0.1:54322/postgres" },
        ],
      }),
    ),
});

const Stopped = Terminal.component({
  name: "Stopped",
  props: Schema.Struct({ unicode: Schema.Boolean }),
  model: Schema.Struct({}),
  message: Schema.Never,
}).make({
  init: () => ({}),
  update: ($) => $.model,
  view: (h) => {
    const { unicode } = h.props;
    return h.box
      .style({ flexDirection: "column" })
      .children(
        Spinner(h, { key: "a", props: { label: "linked", status: "succeeded", unicode } }),
        Spinner(h, { key: "b", props: { label: "failed", status: "failed", unicode } }),
        Spinner(h, { key: "c", props: { label: "pending", status: "warning", unicode } }),
      );
  },
});

describe("ui blocks", () => {
  it.effect("KeyValue aligns values, wraps long ones, and keeps the box edge straight", () =>
    TerminalTest.withTestTerminal({ columns: 36, rows: 24 }, (t) =>
      Effect.gen(function* () {
        const fiber = yield* TerminalTest.startOn(t, TerminalHost.run(Boxed, {}));
        const rows = yield* t.untilScreen((r) => r.some((row) => row.startsWith("╰")));
        const box = rows.slice(0, rows.findIndex((row) => row.startsWith("╰")) + 1);
        expect(box).toEqual([
          "╭─────────────────────────────────╮",
          "│ • Name   日本語のプロジェクト   │",
          "│          🚀                     │",
          "│ • DB URL postgresql://127.0.0.1 │",
          "│          :54322/postgres        │",
          "╰─────────────────────────────────╯",
        ]);
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );

  it.effect("Select cuts a label that does not fit and keeps one row per option", () =>
    TerminalTest.withTestTerminal({ columns: 24, rows: 8 }, (t) =>
      Effect.gen(function* () {
        const props = {
          message: "Which region?",
          options: [{ label: "Southeast Asia (Singapore)", hint: "far" }, { label: "West EU" }],
          unicode: true,
        };
        const fiber = yield* TerminalTest.startOn(t, TerminalHost.run(Select, props));
        const rows = yield* t.untilScreen(showing("●"));
        expect(rows.slice(0, 4)).toEqual([
          "◆ Which region?",
          "│ ● Southeast As… (far)",
          "│ ○ West EU",
          "└",
        ]);
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );

  it.effect.each([
    { unicode: true, glyphs: ["✔ linked", "✖ failed", "▲ pending"] },
    { unicode: false, glyphs: ["+ linked", "x failed", "! pending"] },
  ])("Spinner draws a glyph per stopped status with unicode $unicode", (row) =>
    TerminalTest.withTestTerminal({ columns: 24, rows: 6 }, (t) =>
      Effect.gen(function* () {
        const fiber = yield* TerminalTest.startOn(
          t,
          TerminalHost.run(Stopped, { unicode: row.unicode }),
        );
        const rows = yield* t.untilScreen(showing("pending"));
        expect(rows.slice(0, 3)).toEqual(row.glyphs);
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );
});
