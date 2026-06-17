/**
 * Byte-faithful reproduction of Go's `encoding/json` value encoder for the
 * legacy commands that must match Go's stdout exactly (`db lint` / `db advisors`
 * pretty-print `[]Result` / `[]Lint` via `json.Encoder.SetIndent("", "  ")`).
 *
 * Unlike `legacy-go-output.encoders.ts`'s `encodeGoJson`, this encoder does NOT
 * sort object keys — Go serializes structs in field-declaration order, so the
 * caller builds plain objects whose key insertion order is the Go struct order
 * (JS preserves string-key insertion order). `omitempty` is likewise the
 * caller's responsibility: simply omit the key.
 *
 * The two behaviours `JSON.stringify(x, null, 2)` gets wrong for Go parity are:
 *   1. HTML escaping — Go's default encoder escapes `<`, `>`, `&` as
 *      `<` / `>` / `&` (it does not call `SetEscapeHTML(false)`).
 *   2. Control characters — Go emits `` / `` for backspace / form
 *      feed (no `\b` / `\f` shorthand) and escapes U+2028 / U+2029.
 * This encoder reproduces both; the indentation/`": "`/`[]`/`{}` shape is
 * otherwise identical to `JSON.stringify(x, null, 2)`.
 */

const HEX = "0123456789abcdef";

function unicodeEscape(codeUnit: number): string {
  return `\\u${HEX[(codeUnit >> 12) & 0xf]}${HEX[(codeUnit >> 8) & 0xf]}${HEX[(codeUnit >> 4) & 0xf]}${HEX[codeUnit & 0xf]}`;
}

/**
 * Quotes and escapes a string exactly as Go's `encoding/json` does with the
 * default `escapeHTML: true`. Iterates by UTF-16 code unit; the only non-ASCII
 * runes Go escapes are U+2028 / U+2029 (both single BMP code units), so code
 * units suffice.
 */
export function escapeGoJsonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    switch (code) {
      case 0x22: // "
        out += '\\"';
        break;
      case 0x5c: // \
        out += "\\\\";
        break;
      case 0x0a: // \n
        out += "\\n";
        break;
      case 0x0d: // \r
        out += "\\r";
        break;
      case 0x09: // \t
        out += "\\t";
        break;
      case 0x3c: // <
        out += "\\u003c";
        break;
      case 0x3e: // >
        out += "\\u003e";
        break;
      case 0x26: // &
        out += "\\u0026";
        break;
      case 0x2028:
      case 0x2029:
        out += unicodeEscape(code);
        break;
      default:
        out += code < 0x20 ? unicodeEscape(code) : value[i];
    }
  }
  return out + '"';
}

function walk(value: unknown, depth: number): string {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "string":
      return escapeGoJsonString(value);
    case "number":
      // Finite numbers from JSON parsing render identically to Go for the
      // integer and ordinary-float cases relevant here; defer to JSON.stringify
      // for the canonical shortest representation.
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
  }
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => indent + walk(item, depth + 1));
    return `[\n${items.join(",\n")}\n${closeIndent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  const lines = entries.map(
    ([key, val]) => `${indent}${escapeGoJsonString(key)}: ${walk(val, depth + 1)}`,
  );
  return `{\n${lines.join(",\n")}\n${closeIndent}}`;
}

/**
 * Encodes a value the way Go's `json.Encoder` with `SetIndent("", "  ")` +
 * `Encode` does: 2-space indentation, object keys in insertion (struct) order,
 * Go string escaping, and a trailing newline.
 */
export function encodeGoJsonIndented(value: unknown): string {
  return walk(value, 0) + "\n";
}
