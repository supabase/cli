/**
 * Appending one `[section]` to a TOML file.
 *
 * `supabase/config.toml` belongs to the whole CLI: users hand-edit it, comment
 * it, and commit it. Round-tripping through `saveProjectConfig` preserves the
 * data but discards every comment and normalizes the formatting the user chose,
 * so the write here is textual — render the table, put it at the end, and leave
 * every other byte alone.
 *
 * Append-only by design: locating an existing table means being right about
 * multiline strings, the three ways to quote a key, and where one table ends.
 * Callers ask the decoded config whether an entry exists instead, so nothing
 * here has to find one.
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
 * Escape a string for a TOML basic (double-quoted) string.
 *
 * Control characters need the same treatment as quotes and backslashes: TOML
 * forbids them raw inside a basic string, and a path is allowed to contain them
 * on Unix — a directory name with an embedded newline is legal. Writing one
 * through verbatim leaves `config.toml` unparseable after the scaffold is
 * already on disk.
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
 * Whether `value` is a number this module can render without lying about it.
 *
 * Bare-rendering is faithful only for a whole, finite, non-negative count —
 * which is what `[workers.<name>] instances` is bounded to. Everything else is
 * either valid TOML the schema refuses (`1.5`, `-1`, `1e21`) or a token TOML has
 * no reading for at all (`String(NaN)` is `NaN`, not `nan`; `String(Infinity)`
 * is `Infinity`, not `inf`). Only the second kind fails a re-parse, so the first
 * kind has to be stopped here.
 */
export function isRenderableTomlNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Render `key` for use in a table header or key position. */
export function tomlKey(key: string): string {
  return isBareKey(key) ? key : quote(key);
}

/**
 * `key = "value"`, or `key = value` for a number.
 *
 * A number has to be rendered bare: quoting it would write a TOML string, and
 * the config schema types `[workers.<name>] instances` as a number — so a quoted
 * count produces a `config.toml` that no longer loads at all.
 *
 * Rendering is all this does, and a bare number is only as good as the caller's.
 * `1.5` and `-1` render as perfectly valid TOML that the worker schema rejects,
 * so `planWorkerEntry`'s re-parse — a syntax check, not a schema one — would
 * pass them straight through. {@link isRenderableTomlNumber} is the guard that
 * makes that impossible, and it runs before this does.
 */
function renderPair(key: string, value: string | number): string {
  return `${tomlKey(key)} = ${typeof value === "number" ? String(value) : quote(value)}`;
}

/**
 * `text` with a `[header]` table holding `values` appended to the end.
 *
 * Cannot fail: the caller has already established that no such table exists, so
 * there is nothing to reconcile. A file that is empty (or only whitespace) gets
 * no leading blank line; an existing one gets exactly one, however it happened
 * to be terminated.
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
