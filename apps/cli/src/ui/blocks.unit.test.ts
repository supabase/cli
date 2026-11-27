import { Story } from "@effect/ui/testing";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { Select, SelectEvents, SelectMessage } from "./blocks.ts";

const props = {
  message: "Which region?",
  options: [{ label: "East US" }, { label: "West EU" }, { label: "Southeast Asia" }],
  unicode: true,
};

type SelectState = { readonly highlighted: number; readonly submitted: boolean };

const last = props.options.length - 1;

const spec = (before: SelectState, message: typeof SelectMessage.Type): SelectState => {
  if (before.submitted) return before;
  switch (message._tag) {
    case "PressedUp":
      return { ...before, highlighted: before.highlighted === 0 ? last : before.highlighted - 1 };
    case "PressedDown":
      return { ...before, highlighted: before.highlighted === last ? 0 : before.highlighted + 1 };
    case "PressedHome":
      return { ...before, highlighted: 0 };
    case "PressedEnd":
      return { ...before, highlighted: last };
    case "PressedEnter":
      return { ...before, submitted: true };
  }
};

describe("Select", () => {
  it.effect("reports the highlighted option on Enter and stops listening for keys", () =>
    Effect.gen(function* () {
      const s = yield* Story.make(Select, props);
      expect(s.subscriptions).toHaveLength(1);

      s.send(SelectMessage.PressedUp()).send(SelectMessage.PressedEnter());

      s.emitted(SelectEvents.Submitted({ index: last }));
      expect(s.subscriptions).toEqual([]);
    }),
  );

  it("follows its key spec for every order of key presses", () => {
    const explored = Story.explore(Select, props, {
      messages: [
        SelectMessage.PressedUp(),
        SelectMessage.PressedDown(),
        SelectMessage.PressedHome(),
        SelectMessage.PressedEnd(),
        SelectMessage.PressedEnter(),
      ],
      transition: ({ before, message, after }) => {
        expect(after).toEqual(spec(before, message));
      },
      depth: 6,
    });
    expect(explored.closed).toBe(true);
  });
});
