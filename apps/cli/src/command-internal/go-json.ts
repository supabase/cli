/**
 * Byte-faithful reproduction of `encoding/json`'s encoder, for commands that must match Go's
 * stdout exactly.
 *
 * Doesn't sort object keys — the caller builds objects whose key insertion order is already the
 * desired order; a `Map` is preserved as true insertion order (a plain object reorders
 * integer-like string keys into ascending numeric order, which would undo a lexicographic sort).
 *
 * Differs from `JSON.stringify(x, null, 2)` in escaping `<`, `>`, `&`, and control characters
 * (`\u0008`/`\u000c` instead of `\b`/`\f`) the way Go's default encoder does.
 */

const HEX = "0123456789abcdef";

function unicodeEscape(codeUnit: number): string {
  return `\\u${HEX[(codeUnit >> 12) & 0xf]}${HEX[(codeUnit >> 8) & 0xf]}${HEX[(codeUnit >> 4) & 0xf]}${HEX[codeUnit & 0xf]}`;
}

/**
 * Quotes and escapes a string exactly as `encoding/json` does with default HTML escaping.
 * Iterates by UTF-16 code unit; the only non-ASCII runes Go escapes (U+2028, U+2029) are single
 * BMP code units, so code units suffice.
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

function walk(value: unknown, depth: number, pretty: boolean): string {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "string":
      return escapeGoJsonString(value);
    case "number":
      // JSON.stringify collapses `-0` to `"0"`, but `encoding/json` marshals a float64 negative
      // zero as `-0` — reachable via `gen bearer-jwt`'s signed payload, where the signed bytes
      // must match.
      if (!Number.isFinite(value)) return "null";
      return Object.is(value, -0) ? "-0" : JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
  }
  const indent = pretty ? "  ".repeat(depth + 1) : "";
  const closeIndent = pretty ? "  ".repeat(depth) : "";
  const open = pretty ? "\n" : "";
  const separator = pretty ? ",\n" : ",";
  const close = pretty ? "\n" : "";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => indent + walk(item, depth + 1, pretty));
    return `[${open}${items.join(separator)}${close}${closeIndent}]`;
  }
  // A plain object reorders integer-like string keys ("2", "10") into ascending numeric order on
  // enumeration, unlike a real Go map's lexicographic order; callers needing that order (e.g.
  // `sortKeysDeep`) pass a `Map`, whose iteration order is true insertion order.
  const entries =
    value instanceof Map
      ? [...(value as Map<string, unknown>).entries()]
      : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  const colon = pretty ? ": " : ":";
  const lines = entries.map(
    ([key, val]) => `${indent}${escapeGoJsonString(key)}${colon}${walk(val, depth + 1, pretty)}`,
  );
  return `{${open}${lines.join(separator)}${close}${closeIndent}}`;
}

/**
 * Encodes a value the way `json.Encoder` with `SetIndent("", " ")` +
 * `Encode` does: 2-space indentation, object keys in insertion (struct) order,
 * Go string escaping, and a trailing newline.
 */
export function encodeGoJsonIndented(value: unknown): string {
  return walk(value, 0, true) + "\n";
}

/**
 * Encodes a value the way `json.Marshal` does: compact separators
 * (`{"k":v}`), object keys in insertion (struct) order, Go string escaping
 * (HTML characters included), and no trailing newline.
 */
export function encodeGoJsonCompact(value: unknown): string {
  return walk(value, 0, false);
}

/**
 * `encoding/json` type names for the JSON-representable kinds `json.Unmarshal` rejects. Used to
 * reproduce Go's exact `"json: cannot unmarshal <kind> into Go value of type <target>"` message.
 */
export function goJsonKindName(value: unknown): string {
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "bool";
    default:
      return "value";
  }
}
