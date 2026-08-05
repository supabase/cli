/**
 * Byte-faithful reproduction of Go's `encoding/json` value encoder for the
 * legacy commands that must match Go's stdout exactly (`db lint` / `db advisors`
 * pretty-print `[]Result` / `[]Lint` via `json.Encoder.SetIndent("", "  ")`).
 *
 * Unlike `legacy-go-output.encoders.ts`'s `encodeGoJson`, this encoder does NOT
 * sort object keys — Go serializes structs in field-declaration order, so the
 * caller builds plain objects whose key insertion order is the Go struct order
 * (JS preserves string-key insertion order, EXCEPT for integer-like keys — see
 * the `Map` handling below). `omitempty` is likewise the caller's responsibility:
 * simply omit the key.
 *
 * A caller that needs Go's true lexicographic map-key order (e.g.
 * `legacy-go-output.encoders.ts`'s `sortKeysDeep`, for a genuine Go map like
 * `jwt.MapClaims`) must pass a `Map<string, unknown>` rather than a plain object at
 * that level: a plain object silently reorders integer-like string keys ("2", "10")
 * into ascending NUMERIC order on enumeration, regardless of insertion order, which
 * would undo a lexicographic sort for any numeric-looking key. `Map` iteration order
 * is true insertion order for every key shape, so this walker special-cases it.
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

function walk(value: unknown, depth: number, pretty: boolean): string {
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
  // A plain object silently reorders integer-like string keys ("2", "10") into ascending
  // NUMERIC order on any enumeration (`Object.keys`/`Object.entries`), regardless of insertion
  // order (ECMA-262 `OrdinaryOwnPropertyKeys`) — Go's `encoding/json` has no such special case,
  // so a real Go map's string keys sort purely lexicographically (`"10"` before `"2"`). Callers
  // that need that exact order (e.g. `legacy-go-output.encoders.ts`'s `sortKeysDeep`) pass a
  // `Map` instead of a plain object specifically to carry the sort through intact — `Map`
  // iteration order is true insertion order for every key shape, unlike a plain object
  // (CLI-1961 Codex review finding: `{"10":"a","2":"b"}` must stay "10" before "2").
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
 * Encodes a value the way Go's `json.Encoder` with `SetIndent("", "  ")` +
 * `Encode` does: 2-space indentation, object keys in insertion (struct) order,
 * Go string escaping, and a trailing newline.
 */
export function encodeGoJsonIndented(value: unknown): string {
  return walk(value, 0, true) + "\n";
}

/**
 * Encodes a value the way Go's `json.Marshal` does: compact separators
 * (`{"k":v}`), object keys in insertion (struct) order, Go string escaping
 * (HTML characters included), and no trailing newline.
 */
export function encodeGoJsonCompact(value: unknown): string {
  return walk(value, 0, false);
}

/**
 * Go's `encoding/json` type names for the JSON-representable kinds `json.Unmarshal`
 * rejects. Shared by every legacy command that reproduces Go's exact `"json: cannot
 * unmarshal <kind> into Go value of type <target>"` wording against its own target
 * type — `gen bearer-jwt`'s `jwt.MapClaims` (`bearer-jwt.claims.ts`) and `config.JWK`
 * (`bearer-jwt.signing-key.ts`) are today's two callers.
 */
export function legacyGoJsonKindName(value: unknown): string {
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
