import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import * as Select from "./select.ts";
import { render } from "./test-support.ts";

const abc = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta", hint: "second" },
  { value: "c", label: "Gamma" },
];

const tenOptions = Array.from({ length: 10 }, (_, index) => ({
  value: `v${index}`,
  label: `Option ${index}`,
}));

/** Renders the select on a terminal whose live region is 40 columns wide. */
const show = (model: Select.Model, rows: number) =>
  render(Select.view(model, { message: "Pick one", rows }), { columns: 41, rows: 24 });

describe("Select view", () => {
  it.effect("lists every option under the header while they fit", () =>
    Effect.gen(function* () {
      const { lines } = yield* show(Select.init(abc, "b"), 10);

      expect(lines).toEqual(["◆ Pick one", "│ ○ Alpha", "│ ● Beta (second)", "│ ○ Gamma", "└"]);
    }),
  );

  it.effect("shows the chosen label once submitted", () =>
    Effect.gen(function* () {
      const submitted = Select.update(Select.init(abc, "b"), Select.Message.Confirmed()).model;

      const { lines } = yield* show(submitted, 10);

      expect(lines).toEqual(["◇ Pick one", "│ Beta"]);
    }),
  );

  it.effect("colors only glyphs and hints, and bolds the highlighted label", () =>
    Effect.gen(function* () {
      const { bytes } = yield* show(Select.init(abc, "b"), 10);

      const muted = (text: string) => `\u001b[38;5;245m${text}\u001b[0m`;
      const accent = (text: string) => `\u001b[38;5;78m${text}\u001b[0m`;
      const bold = (text: string) => `\u001b[1m${text}\u001b[0m`;
      expect(bytes).toContain(`${muted("│")} ${muted("○")} Alpha`);
      expect(bytes).toContain(`${muted("│")} ${accent("●")} ${bold("Beta")}${muted(" (second)")}`);
    }),
  );

  it.effect("keeps the highlight inside a window of the rows it is given", () =>
    Effect.gen(function* () {
      for (const highlighted of tenOptions.keys()) {
        const { lines } = yield* show(Select.init(tenOptions, `v${highlighted}`), 4);

        expect(lines).toHaveLength(4);
        expect(lines.filter((line) => line.startsWith("│ ●"))).toEqual([
          `│ ● Option ${highlighted}`,
        ]);
      }
    }),
  );
});
