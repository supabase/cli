import { UiSchema } from "@effect/ui";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { Terminal, TerminalSubscription } from "./index.ts";
import { TerminalTest } from "./testing/index.ts";

const Card = Terminal.component({
  name: "Card",
  model: Schema.Struct({}),
  message: UiSchema.TaggedEnum({ Never: {} }),
}).make({
  init: () => ({}),
  update: { Never: ($) => $.model },
  view: (h) =>
    h.box
      .style({ border: "rounded", paddingX: 1, flexDirection: "column" })
      .children(
        h.box
          .style({ flexDirection: "row", gap: 2 })
          .children(h.text.children("left"), h.text.children("right")),
        h.text.style({ truncate: true }).children("a line that is far too long to fit"),
        h.text.children("日本語 😀 wide"),
      ),
});

const Emoji = Terminal.component({
  name: "Emoji",
  model: Schema.Struct({}),
  message: UiSchema.TaggedEnum({ Never: {} }),
}).make({
  init: () => ({}),
  update: { Never: ($) => $.model },
  view: (h) =>
    h.box
      .style({ border: "single", flexDirection: "column", width: 14 })
      .children(
        h.text.children("flag 🇺🇸 end"),
        h.text.children("fam 👨‍👩‍👧 end"),
        h.text.children("thumb 👍🏽 end"),
        h.text.children("plain end"),
      ),
});

const PaddingMessage = UiSchema.TaggedEnum({ Loosen: {} });

const Padded = Terminal.component({
  name: "Padded",
  model: Schema.Struct({ tight: Schema.Boolean }),
  message: PaddingMessage,
}).make({
  init: () => ({ tight: true }),
  update: { Loosen: ($) => $.evolve({ tight: false }) },
  subscriptions: () => [
    TerminalSubscription.shortcuts([{ key: "l", message: PaddingMessage.Loosen() }]),
  ],
  view: (h, model) =>
    h.box
      .style({ padding: 1, paddingX: model.tight ? 0 : undefined })
      .children(h.text.children("body")),
});

const screenOf = (component: typeof Card | typeof Emoji, columns: number, rows = 8) =>
  Effect.scoped(
    Effect.gen(function* () {
      const app = yield* TerminalTest.mount(component, {}, { columns, rows });
      return yield* app.terminal.untilScreen((lines) =>
        lines.some((line) => line.includes("╰") || line.includes("└")),
      );
    }),
  );

describe("layout and painting", () => {
  it.effect(
    "fits borders, a row with a gap, truncation and wide glyphs inside one cell less than the terminal",
    () =>
      Effect.gen(function* () {
        const rows = yield* screenOf(Card, 24);
        expect(rows.slice(0, 5)).toEqual([
          "╭─────────────────────╮",
          "│ left  right         │",
          "│ a line that is far… │",
          "│ 日本語 😀 wide      │",
          "╰─────────────────────╯",
        ]);
      }),
  );

  it.effect("keeps the right border aligned past flags, skin tones and ZWJ sequences", () =>
    Effect.gen(function* () {
      const rows = yield* screenOf(Emoji, 30);
      expect(rows.slice(0, 6)).toEqual([
        "┌────────────┐",
        "│flag 🇺🇸 end │",
        "│fam 👨‍👩‍👧 end  │",
        "│thumb 👍🏽 end│",
        "│plain end   │",
        "└────────────┘",
      ]);
    }),
  );

  it.effect("falls back to padding when paddingX is cleared", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* TerminalTest.mount(Padded, {}, { columns: 20, rows: 8 });
        const tight = yield* app.terminal.untilScreen((lines) => lines.includes("body"));
        expect(tight.slice(0, 3)).toEqual(["", "body", ""]);

        yield* app.pressKey("l");
        const loose = yield* app.terminal.untilScreen((lines) => lines.includes(" body"));
        expect(loose.slice(0, 3)).toEqual(["", " body", ""]);
      }),
    ),
  );
});
