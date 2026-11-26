import { describe, expect, it } from "vitest";

import * as Decoder from "./decoder.ts";
import type { Key } from "./key.ts";

const encoder = new TextEncoder();

const decode = (...chunks: ReadonlyArray<string | Uint8Array>): ReadonlyArray<Key> => {
  let state = Decoder.initialState;
  const keys: Array<Key> = [];
  for (const chunk of chunks) {
    const result = Decoder.feed(state, typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    state = result.state;
    keys.push(...result.keys);
  }
  return keys;
};

describe("byte decoder", () => {
  it.each([
    { name: "Up", bytes: "\u001b[A", keys: [{ _tag: "Up" }] },
    { name: "Ctrl+Right", bytes: "\u001b[1;5C", keys: [{ _tag: "Right", ctrl: true }] },
    { name: "Shift+Left", bytes: "\u001b[1;2D", keys: [{ _tag: "Left", shift: true }] },
    { name: "Delete", bytes: "\u001b[3~", keys: [{ _tag: "Delete" }] },
    { name: "SS3 Home", bytes: "\u001bOH", keys: [{ _tag: "Home" }] },
    { name: "Shift+Tab", bytes: "\u001b[Z", keys: [{ _tag: "ShiftTab" }] },
    { name: "CRLF as one Enter", bytes: "\r\n", keys: [{ _tag: "Enter" }] },
    { name: "Ctrl+C byte", bytes: "\u0003", keys: [{ _tag: "Ctrl", letter: "c" }] },
    { name: "Meta+x", bytes: "\u001bx", keys: [{ _tag: "Char", text: "x", meta: true }] },
    { name: "an unknown CSI sequence into no key", bytes: "\u001b[9999;x", keys: [] },
  ])("decodes $name", ({ bytes, keys }) => {
    expect(decode(bytes)).toMatchObject(keys);
  });

  it("emits one Char per grapheme of pasted text", () => {
    expect(decode("a👨‍👩‍👧é")).toMatchObject([
      { _tag: "Char", text: "a" },
      { _tag: "Char", text: "👨‍👩‍👧" },
      { _tag: "Char", text: "é" },
    ]);
  });

  it("keeps a sequence split across chunks until it completes", () => {
    expect(decode("\u001b", "[", "1;5", "A")).toMatchObject([{ _tag: "Up", ctrl: true }]);
  });

  it("keeps a UTF-8 character split across chunks until it completes", () => {
    const bytes = encoder.encode("€");
    expect(decode(bytes.subarray(0, 1), bytes.subarray(1))).toMatchObject([
      { _tag: "Char", text: "€" },
    ]);
  });

  it("holds a lone ESC until it is flushed into Escape", () => {
    const { state, keys } = Decoder.feed(Decoder.initialState, encoder.encode("\u001b"));

    expect(keys).toEqual([]);
    expect(Decoder.hasPendingEscape(state)).toBe(true);
    expect(Decoder.flushEscape(state).keys).toMatchObject([{ _tag: "Escape" }]);
  });
});
