import { describe, expect, test } from "vitest";

import { isModified, Key } from "./key.ts";

describe("isModified", () => {
  test.each([
    ["Ctrl+n", Key.Ctrl({ letter: "n" })],
    ["Shift+Tab", Key.ShiftTab()],
    ["Alt+b", Key.Char({ text: "b", meta: true })],
    ["Shift+Up", Key.Up({ shift: true })],
    ["Ctrl+Delete", Key.Delete({ ctrl: true })],
  ])("is true for %s", (_name, key) => {
    expect(isModified(key)).toBe(true);
  });

  test.each([
    ["b", Key.Char({ text: "b" })],
    ["Up", Key.Up({})],
    ["Enter", Key.Enter({})],
    ["Escape", Key.Escape()],
  ])("is false for %s", (_name, key) => {
    expect(isModified(key)).toBe(false);
  });
});
