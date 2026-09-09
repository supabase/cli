import { describe, expect, it } from "vitest";

import { stringWidth } from "./rune-width.ts";

describe("stringWidth", () => {
  it("counts ASCII as 1 each", () => {
    expect(stringWidth("")).toBe(0);
    expect(stringWidth("abc")).toBe(3);
    expect(stringWidth("hello world")).toBe(11);
  });

  it("counts East Asian Wide/Fullwidth code points as 2", () => {
    expect(stringWidth("日本語")).toBe(6); // CJK
    expect(stringWidth("한글")).toBe(4); // Hangul
    expect(stringWidth("あ")).toBe(2); // Hiragana
    expect(stringWidth("Ａ")).toBe(2); // fullwidth A
    expect(stringWidth("ＡＢ")).toBe(4);
  });

  it("counts emoji as 2 and combining marks as 0", () => {
    expect(stringWidth("👍")).toBe(2);
    expect(stringWidth("🚀x")).toBe(3); // emoji(2) + ascii(1)
    expect(stringWidth("é")).toBe(1); // e + combining acute → 1
    expect(stringWidth("a​b")).toBe(2); // zero-width space contributes 0
  });

  it("treats East Asian Ambiguous as width 1 (modern-terminal default)", () => {
    // U+00A1 (¡) is Ambiguous; Go's runewidth with EastAsianWidth=false counts it as 1.
    expect(stringWidth("¡")).toBe(1);
  });
});
