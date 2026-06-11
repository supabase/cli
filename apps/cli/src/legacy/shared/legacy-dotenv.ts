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
    // godotenv's `locateKeyName` ends the key at the first `=` **or** `:`
    // (YAML-style), so `KEY: value` is accepted; the key chars must be
    // `[A-Za-z0-9_.]`, and any `=`/`:` later in the value is preserved.
    let sep = -1;
    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;
      if (char === "=" || char === ":") {
        sep = i;
        break;
      }
      if (char === " " || char === "\t") continue;
      if (!/[A-Za-z0-9_.]/.test(char)) {
        throw new Error(`unexpected character "${char}" in variable name near "${line}"`);
      }
    }
    const key = sep > 0 ? line.slice(0, sep).trim() : "";
    if (key.length === 0) {
      throw new Error(`unexpected character "${line[0] ?? ""}" in variable name near "${line}"`);
    }
    // godotenv expands `$VAR`/`${VAR}` references against variables defined
    // **earlier in the same file** (the in-progress map), so assign in file order.
    result[key] = parseDotEnvValue(line.slice(sep + 1), result);
  }
  return result;
}

// godotenv's `expandVarRegex` (`joho/godotenv/parser.go:253`): an optional
// leading backslash, `$`, an optional `(`, an optional `{`, an optional
// `[A-Z0-9_]+` name, and an optional `}`.
const EXPAND_VAR_REGEX = /(\\)?(\$)(\()?\{?([A-Z0-9_]+)?\}?/g;

/**
 * Expand `$VAR`/`${VAR}` references, a 1:1 port of godotenv's `expandVariables`
 * (`parser.go:257`): a leading backslash (`\$VAR`) or a `$(`-form is returned
 * with its first character dropped (no expansion / no command substitution); a
 * matched `[A-Z0-9_]+` name expands to `vars[name]` (an undefined reference
 * becomes the empty string); a bare `$` with no name is left unchanged. Only
 * uppercase/digit/underscore names are recognized, matching the Go regex.
 */
function expandVariables(value: string, vars: Record<string, string>): string {
  return value.replace(EXPAND_VAR_REGEX, (match, backslash, _dollar, paren, name) => {
    if (backslash === "\\" || paren === "(") {
      return match.slice(1);
    }
    if (name !== undefined && name !== "") {
      return vars[name] ?? "";
    }
    return match;
  });
}

/**
 * Extract a single dotenv value, matching godotenv's `extractVarValue`
 * (`joho/godotenv/parser.go`). A quoted value runs to its (unescaped) closing
 * quote and anything after it (e.g. a trailing comment) is discarded; an
 * unquoted value runs to the first ` #`/`\t#` inline comment, then is trimmed.
 */
function parseDotEnvValue(raw: string, vars: Record<string, string>): string {
  // godotenv left-trims whitespace after `=` before inspecting the value.
  const value = raw.replace(/^[ \t]+/, "");
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    let end = -1;
    for (let i = 1; i < value.length; i++) {
      // The terminator is a matching quote not preceded by a backslash escape.
      if (value[i] === quote && value[i - 1] !== "\\") {
        end = i;
        break;
      }
    }
    if (end === -1) {
      throw new Error("unterminated quoted value");
    }
    const inner = value.slice(1, end);
    if (quote === '"') {
      // Double-quoted values expand escapes first, then variable references
      // (godotenv: `expandVariables(expandEscapes(value), vars)`): `\n` / `\r`
      // become real newlines, a backslash before any other char (except `$`) is
      // dropped — so `\$` survives to suppress expansion in `expandVariables`.
      const escaped = inner
        .replaceAll("\\n", "\n")
        .replaceAll("\\r", "\r")
        .replace(/\\([^$])/g, "$1");
      return expandVariables(escaped, vars);
    }
    // Single-quoted values are taken literally (no escape or variable expansion).
    return inner;
  }
  // Unquoted values: strip the inline comment, trim, then expand variables.
  return expandVariables(stripInlineComment(value).trim(), vars);
}

/**
 * Strip an unquoted inline comment, matching godotenv: scanning from the right,
 * a `#` preceded by whitespace begins a comment (`54323 # local` → `54323`),
 * while a `#` with no leading whitespace is part of the value (`foo#bar`).
 */
function stripInlineComment(value: string): string {
  for (let i = value.length - 1; i > 0; i--) {
    if (value[i] === "#" && (value[i - 1] === " " || value[i - 1] === "\t")) {
      return value.slice(0, i);
    }
  }
  return value;
}
