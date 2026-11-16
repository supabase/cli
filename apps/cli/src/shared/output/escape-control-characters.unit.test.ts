import { describe, expect, it } from "vitest";
import { escapeControlCharacters } from "./escape-control-characters.ts";

describe("escapeControlCharacters", () => {
  it.each([
    { name: "LF", code: 0x0a, shown: "\\u000a", escaped: true },
    { name: "ESC", code: 0x1b, shown: "\\u001b", escaped: true },
    { name: "the last C0 character", code: 0x1f, shown: "\\u001f", escaped: true },
    { name: "space", code: 0x20, shown: " ", escaped: false },
    { name: "DEL", code: 0x7f, shown: "\\u007f", escaped: true },
    { name: "the last C1 character", code: 0x9f, shown: "\\u009f", escaped: true },
    { name: "NBSP", code: 0xa0, shown: String.fromCodePoint(0xa0), escaped: false },
  ])("renders $name as its escaped or literal form", ({ code, shown, escaped }) => {
    const result = escapeControlCharacters(`remotes.a${String.fromCodePoint(code)}b.auth.sms`);

    expect(result).toBe(`remotes.a${shown}b.auth.sms`);
    expect(result.includes(String.fromCodePoint(code))).toBe(!escaped);
  });
});
