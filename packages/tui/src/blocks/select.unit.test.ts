import { expectNoOutMessage, expectOutMessage, given, message, model, story } from "foldkit/story";
import { describe, expect, test } from "vitest";

import { Key } from "../terminal/public.ts";
import * as Select from "./select.ts";

const abc = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta", hint: "second" },
  { value: "c", label: "Gamma" },
];

/** Keys go through `informKeyPressed` and an options change through `reflectOptions`, as a parent would. */
type Input =
  | { readonly _tag: "Key"; readonly key: Key }
  | { readonly _tag: "Options"; readonly options: ReadonlyArray<Select.SelectOption> };

const drive = (current: Select.Model, input: Input) =>
  input._tag === "Key"
    ? Select.informKeyPressed(current, input.key)
    : { model: Select.reflectOptions(current, input.options) };

const choosing = (highlighted: number) => Select.Phase.Choosing({ highlighted });

const press = (key: Key): Input => ({ _tag: "Key", key });
const replaceOptions = (options: ReadonlyArray<Select.SelectOption>): Input => ({
  _tag: "Options",
  options,
});

describe("Select update", () => {
  test("Up and Down wrap around the ends of the list", () => {
    story(
      drive,
      given(Select.init(abc)),
      message(press(Key.Up({}))),
      model((current) => {
        expect(current.phase).toEqual(choosing(2));
      }),
      message(press(Key.Down({}))),
      model((current) => {
        expect(current.phase).toEqual(choosing(0));
      }),
      message(press(Key.Down({}))),
      model((current) => {
        expect(current.phase).toEqual(choosing(1));
      }),
    );
  });

  test("Home and End jump to the first and last option", () => {
    story(
      drive,
      given(Select.init(abc, "b")),
      message(press(Key.End({}))),
      model((current) => {
        expect(current.phase).toEqual(choosing(2));
      }),
      message(press(Key.Home({}))),
      model((current) => {
        expect(current.phase).toEqual(choosing(0));
      }),
    );
  });

  test("Enter emits Selected once and every later key is ignored", () => {
    story(
      drive,
      given(Select.init(abc)),
      message(press(Key.Down({}))),
      expectNoOutMessage(),
      message(press(Key.Enter({}))),
      expectOutMessage(Select.OutMessage.Selected({ value: "b" })),
      model((current) => {
        expect(current.phase).toEqual(Select.Phase.Submitted({ option: abc[1]! }));
      }),
      message(press(Key.Down({}))),
      message(press(Key.Enter({}))),
      expectNoOutMessage(),
      model((current) => {
        expect(current.phase).toEqual(Select.Phase.Submitted({ option: abc[1]! }));
      }),
    );
  });

  test("keys that mean nothing to a select change nothing", () => {
    story(
      drive,
      given(Select.init(abc)),
      message(press(Key.Char({ text: "x" }))),
      message(press(Key.Left({}))),
      expectNoOutMessage(),
      model((current) => {
        expect(current).toEqual(Select.init(abc));
      }),
    );
  });

  test.each([
    ["Alt+Enter", Key.Enter({ meta: true })],
    ["Ctrl+Down", Key.Down({ ctrl: true })],
    ["Alt+Up", Key.Up({ meta: true })],
    ["Shift+Home", Key.Home({ shift: true })],
    ["Ctrl+n", Key.Ctrl({ letter: "n" })],
    ["Shift+Tab", Key.ShiftTab()],
  ])("%s does not submit or move the highlight", (_name, key) => {
    story(
      drive,
      given(Select.init(abc)),
      message(press(key)),
      expectNoOutMessage(),
      model((current) => {
        expect(current).toEqual(Select.init(abc));
      }),
    );
  });

  test("a select with no options ignores Enter and navigation", () => {
    story(
      drive,
      given(Select.init([])),
      message(press(Key.Down({}))),
      message(press(Key.Enter({}))),
      expectNoOutMessage(),
      model((current) => {
        expect(current.phase).toEqual(choosing(0));
      }),
    );
  });

  test("reflectOptions follows the highlighted value, emits nothing, and Selected comes only on Enter", () => {
    story(
      drive,
      given(Select.init(abc, "b")),
      message(replaceOptions([abc[0]!])),
      expectNoOutMessage(),
      model((current) => {
        expect(current.options).toEqual([abc[0]]);
        expect(current.phase).toEqual(choosing(0));
      }),
      message(press(Key.Enter({}))),
      expectOutMessage(Select.OutMessage.Selected({ value: "a" })),
    );
  });

  test("reflectOptions keeps the highlighted value when it moves to another index", () => {
    story(
      drive,
      given(Select.init(abc, "c")),
      message(replaceOptions([abc[2]!, abc[0]!])),
      model((current) => {
        expect(current.phase).toEqual(choosing(0));
      }),
    );
  });
});
