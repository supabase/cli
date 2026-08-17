/**
 * Port of Go's `strconv.Quote` (the `%q` verb) over raw UTF-8 bytes, shared by
 * every legacy error message that must reproduce a Go-side `%q` interpolation
 * byte-for-byte (snippets download's `invalid urn prefix: %q`, storage cp's
 * pflag `invalid argument %q … parsing %q`).
 *
 * Operating on bytes (not JS strings) matters twice over: Go slices like
 * `s[:9]` cut by byte and can split a multibyte rune — which `%q` then renders
 * as `\xNN` per orphan byte — and Go's escaping decisions are made per decoded
 * rune over those bytes. Callers with a whole JS string in hand encode it
 * first (`new TextEncoder().encode(s)`); note Bun's `process.argv` has already
 * replaced invalid UTF-8 argv bytes with U+FFFD by then, so byte-identical
 * output for *invalid-UTF-8 argv* is unattainable at that boundary — the
 * fidelity gap is JS-runtime-wide, not per-call-site.
 */

/**
 * `utf8.DecodeRune` semantics over a byte slice: returns the code point and
 * byte size at `i`, or `cp: -1` with `size: 1` for an invalid byte (invalid
 * lead, truncated/malformed continuation, overlong encoding, surrogate,
 * > U+10FFFF) — exactly the cases Go's `%q` renders as a lone `\xNN`.
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

// Go's `unicode.IsPrint` for runes ≥ 0x80: letters, marks, numbers,
// punctuation, symbols (the ASCII range is handled explicitly in
// legacyGoQuote). Unicode-table drift between the Go and JS engines is
// possible but only affects which escape a garbage rune gets in one error
// message.
const GO_PRINTABLE_RE = /[\p{L}\p{M}\p{N}\p{P}\p{S}]/u;

const GO_ESCAPES: Readonly<Record<number, string>> = {
  0x07: "\\a",
  0x08: "\\b",
  0x0c: "\\f",
  0x0a: "\\n",
  0x0d: "\\r",
  0x09: "\\t",
  0x0b: "\\v",
};

/**
 * Go `%q` (`strconv.Quote`) over raw UTF-8 bytes (go1.26: `%q` of
 * `"12345678\xc3"` → `"12345678\xc3"`). Valid printable runes print
 * literally; control/non-printable ones use Go's `\a…\v` shorthands then
 * `\xNN` / `\uNNNN` / `\UNNNNNNNN`.
 */
export function legacyGoQuote(bytes: Uint8Array): string {
  let out = '"';
  for (let i = 0; i < bytes.length; ) {
    const { cp, size } = decodeUtf8Rune(bytes, i);
    if (cp === -1) {
      out += `\\x${(bytes[i] ?? 0).toString(16).padStart(2, "0")}`;
      i += 1;
      continue;
    }
    i += size;
    const escape = GO_ESCAPES[cp];
    const ch = String.fromCodePoint(cp);
    if (ch === '"' || ch === "\\") out += `\\${ch}`;
    else if (escape !== undefined) out += escape;
    else if (cp >= 0x20 && cp < 0x7f) out += ch;
    else if (cp < 0x80) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (GO_PRINTABLE_RE.test(ch)) out += ch;
    else if (cp < 0x10000) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += `\\U${cp.toString(16).padStart(8, "0")}`;
  }
  return `${out}"`;
}
