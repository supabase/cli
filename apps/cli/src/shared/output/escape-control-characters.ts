/** Renders C0, DEL and C1 characters as `\uXXXX` so user-controlled text can't inject terminal escapes or fake lines. */
export function escapeControlCharacters(text: string): string {
  let escaped = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    escaped +=
      code < 0x20 || (code >= 0x7f && code <= 0x9f)
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : character;
  }
  return escaped;
}
