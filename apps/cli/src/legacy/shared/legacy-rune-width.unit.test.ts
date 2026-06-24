import { describe, expect, it } from "vitest";

import { legacyStringWidth } from "./legacy-rune-width.ts";

describe("legacyStringWidth", () => {
  it("counts ASCII as 1 each", () => {
    expect(legacyStringWidth("")).toBe(0);
    expect(legacyStringWidth("abc")).toBe(3);
    expect(legacyStringWidth("hello world")).toBe(11);
  });

  it("counts East Asian Wide/Fullwidth code points as 2", () => {
    expect(legacyStringWidth("日本語")).toBe(6); // CJK
    expect(legacyStringWidth("한글")).toBe(4); // Hangul
    expect(legacyStringWidth("あ")).toBe(2); // Hiragana
    expect(legacyStringWidth("Ａ")).toBe(2); // fullwidth A
    expect(legacyStringWidth("ＡＢ")).toBe(4);
  });

  it("counts emoji as 2 and combining marks as 0", () => {
    expect(legacyStringWidth("👍")).toBe(2);
    expect(legacyStringWidth("🚀x")).toBe(3); // emoji(2) + ascii(1)
    expect(legacyStringWidth("é")).toBe(1); // e + combining acute → 1
    expect(legacyStringWidth("a​b")).toBe(2); // zero-width space contributes 0
  });

  it("treats East Asian Ambiguous as width 1 (modern-terminal default)", () => {
    // U+00A1 (¡) is Ambiguous; Go's runewidth with EastAsianWidth=false counts it as 1.
    expect(legacyStringWidth("¡")).toBe(1);
  });
});
