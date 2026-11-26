import { describe, expect, it } from "vitest";

import { graphemes, width } from "./width.ts";

describe("display width", () => {
  it.each([
    { name: "ASCII", text: "abc", cells: 3 },
    { name: "East Asian wide characters", text: "日本", cells: 4 },
    { name: "emoji presentation", text: "😀", cells: 2 },
    { name: "a combining mark", text: "é", cells: 1 },
    { name: "a text symbol with VS16", text: "❤️", cells: 2 },
    { name: "a text symbol with VS15", text: "\u263a\ufe0e", cells: 1 },
    { name: "a keycap", text: "1️⃣", cells: 2 },
    { name: "a control character", text: "\u0007", cells: 0 },
    { name: "a ZWJ family", text: "👨‍👩‍👧", cells: 2 },
    { name: "a flag", text: "🇺🇸", cells: 2 },
    { name: "a skin-tone modifier", text: "👍🏽", cells: 2 },
    { name: "a ZWJ sequence on a text-presentation base", text: "🏳️‍🌈", cells: 2 },
    { name: "a decomposed accent", text: "e\u0301", cells: 1 },
    { name: "emoji between letters", text: "a👨‍👩‍👧b", cells: 4 },
  ])("measures $name", ({ text, cells }) => {
    expect(width(text)).toBe(cells);
  });

  it("segments a ZWJ sequence and a combining mark into single graphemes", () => {
    expect(graphemes("👨‍👩‍👧é")).toEqual(["👨‍👩‍👧", "é"]);
  });
});
