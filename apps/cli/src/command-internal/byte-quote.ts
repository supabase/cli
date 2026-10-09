/**
 * Double-quotes a string over raw UTF-8 bytes for error messages.
 *
 * Operates on bytes, not JS strings: a byte slice can split a multibyte code point (rendered as
 * `\xNN` per orphan byte). Callers with a whole JS string encode it first; invalid UTF-8 in
 * `process.argv` has already been replaced with U+FFFD by then.
 */

/**
 * Decodes the UTF-8 code point at `i`, returning its value and byte length, or `cp: -1` with
 * `size: 1` for an invalid or truncated sequence.
 */
function decodeUtf8Rune(
  bytes: Uint8Array,
  i: number,
): { readonly cp: number; readonly size: number } {
  const b0 = bytes[i] ?? 0;
  if (b0 < 0x80) return { cp: b0, size: 1 };
  let extra: number;
  let cp: number;
  let min: number;
  if (b0 >= 0xc0 && b0 <= 0xdf) {
    extra = 1;
    cp = b0 & 0x1f;
    min = 0x80;
  } else if (b0 >= 0xe0 && b0 <= 0xef) {
    extra = 2;
    cp = b0 & 0x0f;
    min = 0x800;
  } else if (b0 >= 0xf0 && b0 <= 0xf7) {
    extra = 3;
    cp = b0 & 0x07;
    min = 0x10000;
  } else {
    return { cp: -1, size: 1 };
  }
  if (i + extra >= bytes.length) return { cp: -1, size: 1 };
  for (let k = 1; k <= extra; k++) {
    const b = bytes[i + k] ?? 0;
    if ((b & 0xc0) !== 0x80) return { cp: -1, size: 1 };
    cp = (cp << 6) | (b & 0x3f);
  }
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return { cp: -1, size: 1 };
  return { cp, size: extra + 1 };
}

// Printable code points ≥ 0x80: letters, marks, numbers, punctuation, symbols (ASCII is handled
// explicitly in quoteBytes). Unicode-table drift between engines only affects which escape a garbage
// code point gets in one error message.
const PRINTABLE_RE = /[\p{L}\p{M}\p{N}\p{P}\p{S}]/u;

const ESCAPE_SHORTHANDS: Readonly<Record<number, string>> = {
  0x07: "\\a",
  0x08: "\\b",
  0x0c: "\\f",
  0x0a: "\\n",
  0x0d: "\\r",
  0x09: "\\t",
  0x0b: "\\v",
};

/**
 * Wraps the bytes in double quotes. Valid printable code points print literally, control
 * characters use the `\a \b \f \n \r \t \v` shorthands, each invalid byte becomes `\xNN`, and
 * other non-printable code points become `\uNNNN` or `\UNNNNNNNN`.
 */
export function quoteBytes(bytes: Uint8Array): string {
  let out = '"';
  for (let i = 0; i < bytes.length;) {
    const { cp, size } = decodeUtf8Rune(bytes, i);
    if (cp === -1) {
      out += `\\x${(bytes[i] ?? 0).toString(16).padStart(2, "0")}`;
      i += 1;
      continue;
    }
    i += size;
    const escape = ESCAPE_SHORTHANDS[cp];
    const ch = String.fromCodePoint(cp);
    if (ch === '"' || ch === "\\") out += `\\${ch}`;
    else if (escape !== undefined) out += escape;
    else if (cp >= 0x20 && cp < 0x7f) out += ch;
    else if (cp < 0x80) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (PRINTABLE_RE.test(ch)) out += ch;
    else if (cp < 0x10000) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += `\\U${cp.toString(16).padStart(8, "0")}`;
  }
  return `${out}"`;
}
