import { describe, expect, test } from "vitest";

import { normalize } from "./text.ts";

describe("normalize", () => {
  test.each([
    ["CSI color sequence", "\u001b[1;31mred\u001b[0m text", "red text"],
    ["CSI cursor sequence", "a\u001b[2K\u001b[1Ab", "ab"],
    ["C1 CSI", "a\u009b31mb", "ab"],
    ["OSC ended by BEL", "a\u001b]0;title\u0007b", "ab"],
    ["OSC ended by ST", "a\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\b", "alinkb"],
    ["unterminated OSC", "keep\u001b]0;title never ends", "keep"],
    ["SS3", "a\u001bOPb", "ab"],
    ["charset designation", "a\u001b(Bb", "ab"],
    ["save-cursor", "a\u001b7b", "ab"],
  ])("removes ANSI escape sequences: %s", (_name, input, expected) => {
    expect(normalize(input)).toBe(expected);
  });

  test.each([
    ["CRLF", "a\r\nb", "a\nb"],
    ["lone CR", "a\rb", "a\nb"],
    ["CR then LF-less end", "a\r", "a\n"],
    ["LF stays a hard break", "a\n\nb", "a\n\nb"],
  ])("normalizes line endings to LF: %s", (_name, input, expected) => {
    expect(normalize(input)).toBe(expected);
  });

  test.each([
    ["zero-width space", "a\u200Bb", "ab"],
    ["word joiner", "a\u2060b", "ab"],
    ["byte order mark", "a\uFEFFb", "ab"],
    ["soft hyphen", "a\u00ADb", "ab"],
    ["left-to-right mark", "a\u200Eb", "ab"],
    ["zero-width non-joiner stays", "a\u200Cb", "a\u200Cb"],
    ["zero-width joiner stays", "a\u200Db", "a\u200Db"],
    [
      "emoji tag characters stay",
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
    ],
  ])(
    "removes format characters terminals disagree on and keeps joiners and tags: %s",
    (_name, input, expected) => {
      expect(normalize(input)).toBe(expected);
    },
  );

  test.each([
    ["from column 0", "\tx", undefined, `${" ".repeat(8)}x`],
    ["after one character", "a\tb", undefined, `a${" ".repeat(7)}b`],
    ["on a stop boundary", "12345678\tx", undefined, `12345678${" ".repeat(8)}x`],
    ["after a wide character", "漢\tx", undefined, `漢${" ".repeat(6)}x`],
    ["restarts after a newline", "abc\n\tx", undefined, `abc\n${" ".repeat(8)}x`],
    ["relative to the cells already on the line", "\tx", 3, `${" ".repeat(5)}x`],
  ])("expands tabs to the next multiple of 8: %s", (_name, input, startColumn, expected) => {
    expect(normalize(input, startColumn)).toBe(expected);
  });

  test.each([
    ["NUL", "a\u0000b", "a\uFFFDb"],
    ["BEL", "a\u0007b", "a\uFFFDb"],
    ["backspace", "a\bb", "a\uFFFDb"],
    ["DEL", "a\u007fb", "a\uFFFDb"],
    ["C1 control", "a\u0085b", "a\uFFFDb"],
    ["lone ESC", "a\u001b", "a\uFFFD"],
  ])("replaces remaining controls with U+FFFD: %s", (_name, input, expected) => {
    expect(normalize(input)).toBe(expected);
  });

  test("leaves printable text, emoji and combining marks untouched", () => {
    const text = "plain é 漢字 👩‍💻 1️⃣";
    expect(normalize(text)).toBe(text);
  });

  test.each([
    ["variation selector 16", "\uFE0Fx", "\uFFFDx"],
    ["combining enclosing keycap", "\u20E3x", "\uFFFDx"],
    ["zero-width joiner", "\u200Dx", "\uFFFDx"],
    ["spacing combining mark", "\u093Fx", "\uFFFDx"],
    ["combining mark run", "\u0301\u0301x", "\uFFFDx"],
    ["after a line break", "a\n\u0301x", "a\n\uFFFDx"],
  ])(
    "replaces a grapheme with no base at the start of a hard line: %s",
    (_name, input, expected) => {
      expect(normalize(input)).toBe(expected);
    },
  );

  test("keeps a mark that continues text already on the line", () => {
    expect(normalize("\u0301x", 3)).toBe("\u0301x");
  });
});
