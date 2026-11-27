const isControl = (code: number): boolean =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x200e ||
  code === 0x200f ||
  (code >= 0x2028 && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

/** Renders control, bidi and line-separator characters as `\\uXXXX` so user-controlled text can't inject terminal escapes or fake lines. */
export function escapeControlCharacters(text: string): string {
  let escaped = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    escaped += isControl(code) ? `\\u${code.toString(16).padStart(4, "0")}` : character;
  }
  return escaped;
}
