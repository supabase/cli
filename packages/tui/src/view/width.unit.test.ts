import { describe, expect, test } from "vitest";

import { graphemes, width } from "./width.ts";

describe("width", () => {
  test.each([
    ["empty", "", 0],
    ["ASCII", "hello", 5],
    ["CJK ideographs", "漢字", 4],
    ["Hangul syllable", "한", 2],
    ["fullwidth Latin", "Ａ", 2],
    ["combining acute accent", "é", 1],
    ["precomposed accent", "é", 1],
    ["emoji presentation", "😀", 2],
    ["text symbol with VS16", "❤️", 2],
    ["keycap with VS16", "1️⃣", 2],
    ["keycap without VS16", "#⃣", 2],
    ["ZWJ pair: each emoji counts", "👩‍💻", 4],
    ["ZWJ family: each emoji counts", "👨‍👩‍👧", 6],
    ["skin tone modifier adds a cell", "👍🏽", 4],
    ["zero width space", "a​b", 2],
  ])("%s", (_name, text, expected) => {
    expect(width(text)).toBe(expected);
  });
});

describe("graphemes", () => {
  test.each([
    ["combining mark stays with its base", "éx", ["é", "x"]],
    ["keycap is one cluster", "1️⃣a", ["1️⃣", "a"]],
    ["ZWJ sequence is one cluster", "👩‍💻!", ["👩‍💻", "!"]],
  ])("%s", (_name, text, expected) => {
    expect(graphemes(text)).toEqual(expected);
  });
});
