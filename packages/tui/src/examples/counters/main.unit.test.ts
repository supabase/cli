import { given, message, model, story } from "foldkit/story";
import { describe, expect, test } from "vitest";

import { Key } from "../../terminal/public.ts";
import * as Counter from "./counter.ts";
import { Lifecycle, Message, update, type Model } from "./main.ts";

const row = (id: string, count = 0) => ({ id, counter: { count } });

const initialModel: Model = {
  rows: [row("counter-0"), row("counter-1")],
  nextRowId: 2,
  focus: 0,
  lifecycle: Lifecycle.Counting(),
};

const press = (key: Key) => Message.PressedKey({ key });
const char = (text: string) => press(Key.Char({ text }));

const counts = (model: Model) => model.rows.map((entry) => entry.counter.count);

describe("update", () => {
  test("a appends a fresh row with the next id and focuses it", () => {
    story(
      update,
      given(initialModel),
      message(char("a")),
      model((model) => {
        expect(model.rows.map((entry) => entry.id)).toEqual([
          "counter-0",
          "counter-1",
          "counter-2",
        ]);
        expect(model.nextRowId).toBe(3);
        expect(model.focus).toBe(2);
      }),
    );
  });

  test("x removes the focused row and keeps focus on a surviving row", () => {
    story(
      update,
      given({ ...initialModel, focus: 1 }),
      message(char("x")),
      model((model) => {
        expect(model.rows.map((entry) => entry.id)).toEqual(["counter-0"]);
        expect(model.focus).toBe(0);
      }),
      message(press(Key.Backspace({}))),
      model((model) => {
        expect(model.rows).toEqual([]);
        expect(model.focus).toBe(0);
      }),
    );
  });

  test("Up and Down move focus and stop at the ends", () => {
    story(
      update,
      given(initialModel),
      message(press(Key.Up({}))),
      model((model) => {
        expect(model.focus).toBe(0);
      }),
      message(press(Key.Down({}))),
      message(press(Key.Down({}))),
      model((model) => {
        expect(model.focus).toBe(1);
      }),
    );
  });

  test("Right and Left reach only the focused row's counter", () => {
    story(
      update,
      given({ ...initialModel, focus: 1 }),
      message(press(Key.Right({}))),
      message(char("+")),
      message(press(Key.Left({}))),
      model((model) => {
        expect(counts(model)).toEqual([0, 1]);
      }),
      message(press(Key.Up({}))),
      message(char("-")),
      model((model) => {
        expect(counts(model)).toEqual([-1, 1]);
      }),
    );
  });

  test.each([
    ["Alt+q", Key.Char({ text: "q", meta: true })],
    ["Alt+a", Key.Char({ text: "a", meta: true })],
    ["Alt+Down", Key.Down({ meta: true })],
    ["Ctrl+Delete", Key.Delete({ ctrl: true })],
    ["Shift+Right", Key.Right({ shift: true })],
    ["Ctrl+x", Key.Ctrl({ letter: "x" })],
    ["Shift+Tab", Key.ShiftTab()],
  ])("%s neither navigates, edits rows, quits, nor reaches the counter", (_name, key) => {
    story(
      update,
      given(initialModel),
      message(press(key)),
      model((model) => {
        expect(model).toEqual(initialModel);
      }),
    );
  });

  test("a counter key with no rows leaves the model unchanged", () => {
    const empty: Model = { ...initialModel, rows: [] };
    story(
      update,
      given(empty),
      message(press(Key.Right({}))),
      model((model) => {
        expect(model).toEqual(empty);
      }),
    );
  });

  test("q marks the run done", () => {
    story(
      update,
      given(initialModel),
      message(char("q")),
      model((model) => {
        expect(model.lifecycle).toEqual(Lifecycle.Finished());
      }),
    );
  });

  test("GotCounterMessage reaches the matching row only", () => {
    story(
      update,
      given({ ...initialModel, rows: [row("counter-0", 5), row("counter-1", 5)] }),
      message(
        Message.GotCounterMessage({ id: "counter-0", message: Counter.Message.Decremented() }),
      ),
      message(
        Message.GotCounterMessage({ id: "counter-99", message: Counter.Message.Incremented() }),
      ),
      model((model) => {
        expect(counts(model)).toEqual([4, 5]);
      }),
    );
  });
});
