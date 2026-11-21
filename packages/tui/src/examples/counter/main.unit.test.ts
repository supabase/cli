import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, test } from "vitest";

import { Key } from "../../terminal/public.ts";
import { Lifecycle, Message, update, type Model } from "./main.ts";

const initialModel: Model = { count: 0, lifecycle: Lifecycle.Counting() };

const press = (key: Key) => Message.PressedKey({ key });

describe("update", () => {
  test.each([
    ["Up", Key.Up({})],
    ["+", Key.Char({ text: "+" })],
  ])("%s adds one to the count", (_name, key) => {
    story(
      update,
      given(initialModel),
      message(press(key)),
      Command.expectNone(),
      model((model) => {
        expect(model.count).toBe(1);
      }),
    );
  });

  test.each([
    ["Down", Key.Down({})],
    ["-", Key.Char({ text: "-" })],
  ])("%s subtracts one from the count, past zero too", (_name, key) => {
    story(
      update,
      given(initialModel),
      message(press(key)),
      model((model) => {
        expect(model.count).toBe(-1);
      }),
    );
  });

  test("r sets the count back to zero", () => {
    story(
      update,
      given({ count: 99, lifecycle: Lifecycle.Counting() }),
      message(press(Key.Char({ text: "r" }))),
      model((model) => {
        expect(model.count).toBe(0);
      }),
    );
  });

  test("q marks the run done and keeps the count", () => {
    story(
      update,
      given({ count: 4, lifecycle: Lifecycle.Counting() }),
      message(press(Key.Char({ text: "q" }))),
      model((model) => {
        expect(model).toEqual({ count: 4, lifecycle: Lifecycle.Finished() });
      }),
    );
  });

  test("keys the counter does not use leave the model unchanged", () => {
    story(
      update,
      given(initialModel),
      message(press(Key.Enter({}))),
      message(press(Key.Char({ text: "z" }))),
      model((model) => {
        expect(model).toEqual(initialModel);
      }),
    );
  });

  test.each([
    ["Alt+q", Key.Char({ text: "q", meta: true })],
    ["Alt+Up", Key.Up({ meta: true })],
    ["Ctrl+Down", Key.Down({ ctrl: true })],
    ["Shift+Up", Key.Up({ shift: true })],
    ["Ctrl+r", Key.Ctrl({ letter: "r" })],
    ["Shift+Tab", Key.ShiftTab()],
  ])("%s does not trigger the bare-key action", (_name, key) => {
    story(
      update,
      given(initialModel),
      message(press(key)),
      model((model) => {
        expect(model).toEqual(initialModel);
      }),
    );
  });

  test("successive keys accumulate", () => {
    story(
      update,
      given(initialModel),
      message(press(Key.Up({}))),
      message(press(Key.Up({}))),
      message(press(Key.Up({}))),
      message(press(Key.Down({}))),
      model((model) => {
        expect(model.count).toBe(2);
      }),
    );
  });
});
