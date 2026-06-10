// godotenv.Parse-compatible parser: `KEY=VALUE` / `KEY="VALUE"` lines, `#`
// comments, blank lines, and an optional `export ` prefix. A line with an empty
// or invalid variable name throws (Go's `godotenv.Parse` surfaces
// `unexpected character ... in variable name`).
const EXPORT_PREFIX = /^\s*export\s+/;

/**
 * Minimal godotenv parser for project `.env` files. Returns the parsed key/value
 * map. Throws an `Error` whose message mirrors Go's parser for a malformed
 * variable name so callers can surface the same failure (`"!="` → unexpected
 * character).
 *
 * Shared by `bootstrap` (`.env.example` merge) and the db-config reader's nested
 * `.env` loader (`legacyReadDbToml`), so it lives in `legacy/shared/`.
 */
export function parseDotEnv(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.replace(EXPORT_PREFIX, "").trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      const offending = line.slice(0, eq < 0 ? line.length : eq + 1);
      throw new Error(
        `unexpected character "${line[0] ?? ""}" in variable name near "${offending}"`,
      );
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) {
      throw new Error(`unexpected character "${key[0] ?? ""}" in variable name near "${line}"`);
    }
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      // godotenv expands escapes inside double-quoted values: `\n` / `\r` become
      // real newlines, and a backslash before any other char (except `$`) is
      // dropped (`\"` -> `"`, `\\` -> `\`).
      value = value
        .slice(1, -1)
        .replaceAll("\\n", "\n")
        .replaceAll("\\r", "\r")
        .replace(/\\([^$])/g, "$1");
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      // Single-quoted values are taken literally (no escape expansion).
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
