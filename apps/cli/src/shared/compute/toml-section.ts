/**
 * Appends one `[section]` to a TOML file textually rather than through a parse-and-rewrite
 * round trip, since `saveProjectConfig` would discard the user's comments and formatting.
 * Append-only by design: locating an existing table correctly means handling multiline
 * strings and the three ways to quote a key, so callers ask the decoded config whether an
 * entry exists instead.
 */

/** A TOML bare key needs no quoting; anything else does. */
function isBareKey(key: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(key);
}

/** The escapes TOML names, for the control characters that have one. */
const TOML_NAMED_ESCAPES: Record<string, string> = {
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
};

/**
 * Escapes a string for a TOML basic (double-quoted) string. Control characters need the same
 * treatment as quotes and backslashes: TOML forbids them raw, and a path may legally contain
 * one (an embedded newline in a directory name) — writing it through verbatim would leave
 * `config.toml` unparseable after the scaffold is already on disk.
 */
function quote(value: string): string {
  let escaped = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\") {
      escaped += "\\\\";
    } else if (char === '"') {
      escaped += '\\"';
    } else if (code < 0x20 || code === 0x7f) {
      escaped += TOML_NAMED_ESCAPES[char] ?? `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      escaped += char;
    }
  }
  return `"${escaped}"`;
}

/**
 * Whether `value` is a whole, non-negative, finite number `[compute.<name>] instances` can
 * render without lying: `1.5`/`-1`/`1e21` are valid TOML the schema rejects, while
 * `String(NaN)`/`String(Infinity)` render tokens TOML has no reading for at all. Only the
 * second kind fails a re-parse, so the first kind must be stopped here.
 */
export function isRenderableTomlNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Render `key` for use in a table header or key position. */
export function tomlKey(key: string): string {
  return isBareKey(key) ? key : quote(key);
}

/**
 * `key = "value"`, or `key = value` for a number — quoting a count would write a TOML string,
 * and the schema types `[compute.<name>] instances` as a number, so a quoted count would stop
 * `config.toml` from loading at all. Rendering doesn't validate: {@link isRenderableTomlNumber}
 * is the guard that keeps `1.5`/`-1` from reaching here, since `planComputeEntry`'s re-parse is
 * a syntax check, not a schema one.
 */
function renderPair(key: string, value: string | number): string {
  return `${tomlKey(key)} = ${typeof value === "number" ? String(value) : quote(value)}`;
}

/**
 * `text` with a `[header]` table holding `values` appended to the end. Cannot fail: the
 * caller has already established that no such table exists. An empty (or whitespace-only)
 * file gets no leading blank line; an existing one gets exactly one, however it was
 * terminated.
 */
export function appendTomlSection(
  text: string,
  header: string,
  values: Readonly<Record<string, string | number>>,
): string {
  const block = [
    `[${header}]`,
    ...Object.entries(values).map(([key, value]) => renderPair(key, value)),
  ].join("\n");

  if (text.trim() === "") {
    return `${block}\n`;
  }
  return `${text.replace(/\n*$/, "")}\n\n${block}\n`;
}
