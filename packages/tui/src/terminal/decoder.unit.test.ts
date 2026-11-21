import { describe, expect, it } from "vitest";

import * as Decoder from "./decoder.ts";
import { Key } from "./key.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

const chars = (...texts: ReadonlyArray<string>) => texts.map((text) => Key.Char({ text }));

const decodeAll = (...chunks: ReadonlyArray<Uint8Array>) => {
  let state = Decoder.initialState;
  const keys: Array<Key> = [];
  for (const chunk of chunks) {
    const result = Decoder.feed(state, chunk);
    state = result.state;
    keys.push(...result.keys);
  }
  return { state, keys };
};

describe("Decoder.feed", () => {
  it("decodes a printable run as one Char per character", () => {
    expect(decodeAll(bytes("++")).keys).toEqual(chars("+", "+"));
    expect(decodeAll(bytes("hi!")).keys).toEqual(chars("h", "i", "!"));
  });

  it.each([
    ["a combining mark", "e\u0301x", ["e\u0301", "x"]],
    ["a precomposed character", "éx", ["é", "x"]],
    ["an emoji ZWJ sequence", "a👨‍👩‍👧b", ["a", "👨‍👩‍👧", "b"]],
  ])("keeps %s together as one Char", (_name, input, expected) => {
    expect(decodeAll(bytes(input)).keys).toEqual(chars(...expected));
  });

  it("decodes a multi-byte character split across chunks", () => {
    const encoded = bytes("é");
    const { keys, state } = decodeAll(encoded.slice(0, 1), encoded.slice(1));
    expect(keys).toEqual([Key.Char({ text: "é" })]);
    expect(state.pending).toHaveLength(0);
  });

  it("decodes a four-byte emoji split in the middle", () => {
    const encoded = bytes("a🎉b");
    const { keys } = decodeAll(encoded.slice(0, 3), encoded.slice(3));
    expect(keys).toEqual(chars("a", "🎉", "b"));
  });

  it.each([
    ["\r", Key.Enter({})],
    ["\n", Key.Enter({})],
    ["\t", Key.Tab({})],
    ["\x7f", Key.Backspace({})],
    ["\b", Key.Backspace({})],
    ["\x03", Key.Ctrl({ letter: "c" })],
    ["\x04", Key.Ctrl({ letter: "d" })],
    ["\x01", Key.Ctrl({ letter: "a" })],
    ["\x1a", Key.Ctrl({ letter: "z" })],
  ])("decodes control byte %j", (input, expected) => {
    expect(decodeAll(bytes(input)).keys).toEqual([expected]);
  });

  it("treats CRLF as a single Enter", () => {
    expect(decodeAll(bytes("\r\n")).keys).toEqual([Key.Enter({})]);
  });

  it.each([
    ["\x1b[A", Key.Up({})],
    ["\x1b[B", Key.Down({})],
    ["\x1b[C", Key.Right({})],
    ["\x1b[D", Key.Left({})],
    ["\x1b[H", Key.Home({})],
    ["\x1b[F", Key.End({})],
    ["\x1b[Z", Key.ShiftTab()],
    ["\x1b[3~", Key.Delete({})],
    ["\x1b[5~", Key.PageUp({})],
    ["\x1b[6~", Key.PageDown({})],
    ["\x1b[1~", Key.Home({})],
    ["\x1b[4~", Key.End({})],
    ["\x1bOA", Key.Up({})],
    ["\x1bOB", Key.Down({})],
    ["\x1bOC", Key.Right({})],
    ["\x1bOD", Key.Left({})],
    ["\x1bOH", Key.Home({})],
    ["\x1bOF", Key.End({})],
  ])("decodes escape sequence %j", (input, expected) => {
    const { keys, state } = decodeAll(bytes(input));
    expect(keys).toEqual([expected]);
    expect(state.pending).toHaveLength(0);
  });

  it.each([
    ["Alt+Up", "\x1b[1;3A", Key.Up({ meta: true })],
    ["Ctrl+Right", "\x1b[1;5C", Key.Right({ ctrl: true })],
    ["Meta+Down (xterm meta bit)", "\x1b[1;9B", Key.Down({ meta: true })],
    ["Shift+Left", "\x1b[1;2D", Key.Left({ shift: true })],
    ["Ctrl+Alt+End", "\x1b[1;7F", Key.End({ meta: true, ctrl: true })],
    ["Shift+Delete", "\x1b[3;2~", Key.Delete({ shift: true })],
    ["Ctrl+Delete", "\x1b[3;5~", Key.Delete({ ctrl: true })],
    ["Alt+PageDown", "\x1b[6;3~", Key.PageDown({ meta: true })],
  ])("decodes %s from the xterm modifier parameter", (_name, input, expected) => {
    expect(decodeAll(bytes(input)).keys).toEqual([expected]);
  });

  it("leaves modifier flags off a sequence without a modifier parameter", () => {
    const [up, deleted] = decodeAll(bytes("\x1b[A\x1b[3~")).keys;
    expect(Object.keys(up ?? {})).toEqual(["_tag"]);
    expect(Object.keys(deleted ?? {})).toEqual(["_tag"]);
  });

  it("holds a CSI sequence split across chunks until it completes", () => {
    const first = Decoder.feed(Decoder.initialState, bytes("\x1b["));
    expect(first.keys).toEqual([]);
    expect(Decoder.hasPendingEscape(first.state)).toBe(true);

    const second = Decoder.feed(first.state, bytes("A"));
    expect(second.keys).toEqual([Key.Up({})]);
    expect(Decoder.hasPendingEscape(second.state)).toBe(false);
  });

  it("holds a CSI sequence split before its final byte of a parameterized key", () => {
    const { keys } = decodeAll(bytes("\x1b[3"), bytes("~"));
    expect(keys).toEqual([Key.Delete({})]);
  });

  it("keeps a typed run and a following arrow as separate keys", () => {
    expect(decodeAll(bytes("ab\x1b[Acd")).keys).toEqual([
      ...chars("a", "b"),
      Key.Up({}),
      ...chars("c", "d"),
    ]);
  });

  it("emits a pasted multi-line chunk as Char and Enter keys without losing text", () => {
    const { keys } = decodeAll(bytes("ab\rcd"));
    expect(keys).toEqual([...chars("a", "b"), Key.Enter({}), ...chars("c", "d")]);
  });

  it("drops an unknown CSI sequence and keeps decoding after it", () => {
    expect(decodeAll(bytes("\x1b[99;5xz")).keys).toEqual([Key.Char({ text: "z" })]);
  });

  it.each([
    ["a kitty repeat event", "\x1b[1;3:2A"],
    ["a kitty release event", "\x1b[1;1:3A"],
    ["a private-mode parameter", "\x1b[?1;2A"],
  ])("consumes %s without emitting a key", (_, sequence) => {
    expect(decodeAll(bytes(`${sequence}z`)).keys).toEqual(chars("z"));
  });

  it.each([
    ["ESC O then Enter", "\x1bO\r", "O", Key.Enter({})],
    ["ESC [ then Enter", "\x1b[\r", "[", Key.Enter({})],
    ["ESC [ then DEL", "\x1b[\x7f", "[", Key.Backspace({})],
    ["ESC O then DEL", "\x1bO\x7f", "O", Key.Backspace({})],
    ["ESC O then Tab", "\x1bO\t", "O", Key.Tab({})],
  ])(
    "reports %s as Meta plus the bare prefix character, then the next key",
    (_, input, text, next) => {
      expect(decodeAll(bytes(input)).keys).toEqual([Key.Char({ text, meta: true }), next]);
    },
  );

  it("emits Escape for ESC followed by ESC, then decodes the next key as Meta", () => {
    expect(decodeAll(bytes("\x1b\x1bq")).keys).toEqual([
      Key.Escape(),
      Key.Char({ text: "q", meta: true }),
    ]);
  });

  describe.each([
    ["Alt+Backspace", "\x7f", Key.Backspace({ meta: true })],
    ["Alt+b", "b", Key.Char({ text: "b", meta: true })],
    ["Alt+é", "é", Key.Char({ text: "é", meta: true })],
    ["Alt+Enter", "\r", Key.Enter({ meta: true })],
    ["Alt+Tab", "\t", Key.Tab({ meta: true })],
    ["Alt+Ctrl+a", "\x01", Key.Ctrl({ letter: "a", meta: true })],
  ])("%s as ESC then the key", (_name, key, expected) => {
    it("decodes as a Meta key when both arrive in one read", () => {
      const { keys, state } = decodeAll(bytes(`\x1b${key}`));
      expect(keys).toEqual([expected]);
      expect(state.pending).toHaveLength(0);
    });

    it("decodes as a Meta key when the key arrives in a later read", () => {
      const first = Decoder.feed(Decoder.initialState, bytes("\x1b"));
      expect(first.keys).toEqual([]);
      expect(Decoder.hasPendingEscape(first.state)).toBe(true);

      const second = Decoder.feed(first.state, bytes(key));
      expect(second.keys).toEqual([expected]);
      expect(Decoder.hasPendingEscape(second.state)).toBe(false);
    });
  });

  it("makes only the first character after ESC Meta", () => {
    expect(decodeAll(bytes("\x1bbcd")).keys).toEqual([
      Key.Char({ text: "b", meta: true }),
      ...chars("c", "d"),
    ]);
  });

  it("keeps a decomposed grapheme after ESC together as one Meta key", () => {
    expect(decodeAll(bytes("\x1be\u0301x")).keys).toEqual([
      Key.Char({ text: "e\u0301", meta: true }),
      ...chars("x"),
    ]);
  });

  it("waits for the rest of a multi-byte character after ESC", () => {
    const encoded = bytes("é");
    const { keys } = decodeAll(bytes("\x1b"), encoded.slice(0, 1), encoded.slice(1));
    expect(keys).toEqual([Key.Char({ text: "é", meta: true })]);
  });

  it("never emits Escape for a lone ESC from feed", () => {
    const { keys, state } = decodeAll(bytes("\x1b"));
    expect(keys).toEqual([]);
    expect(Decoder.hasPendingEscape(state)).toBe(true);
  });
});

describe("Decoder.flushEscape", () => {
  it("turns a lone pending ESC into Escape", () => {
    const pending = Decoder.feed(Decoder.initialState, bytes("\x1b")).state;
    const flushed = Decoder.flushEscape(pending);
    expect(flushed.keys).toEqual([Key.Escape()]);
    expect(Decoder.hasPendingEscape(flushed.state)).toBe(false);
  });

  it("drops a half-received sequence instead of emitting Escape", () => {
    const pending = Decoder.feed(Decoder.initialState, bytes("\x1b[1;")).state;
    const flushed = Decoder.flushEscape(pending);
    expect(flushed.keys).toEqual([]);
    expect(Decoder.hasPendingEscape(flushed.state)).toBe(false);
  });

  it("does nothing when nothing is pending", () => {
    expect(Decoder.flushEscape(Decoder.initialState).keys).toEqual([]);
  });
});
