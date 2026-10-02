// godotenv-compatible: `KEY=VALUE`/`KEY="VALUE"` lines, `#` comments, blank lines, and an
// optional `export ` prefix. An empty or invalid variable name throws.
const EXPORT_PREFIX = /^\s*export\s+/;

/**
 * Minimal godotenv-compatible parser for project `.env` files. Throws when a variable name is
 * empty or contains an invalid character.
 */
export function parseDotEnv(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Normalize CRLF→LF and scan the whole buffer with a cursor (not line-by-line), so a quoted
  // value can span newlines (e.g. a PEM block).
  let src = contents.replaceAll("\r\n", "\n");
  for (;;) {
    src = skipToStatementStart(src);
    if (src.length === 0) break;
    // Strip an optional `export ` prefix, then read the key up to the first `=`/`:`. Key chars
    // must be `[A-Za-z0-9_.]`; anything else throws.
    src = src.replace(EXPORT_PREFIX, "");
    let sep = -1;
    for (let i = 0; i < src.length; i++) {
      const char = src[i]!;
      if (char === "=" || char === ":") {
        sep = i;
        break;
      }
      if (char === "\n") break;
      if (char === " " || char === "\t") continue;
      if (!/[A-Za-z0-9_.]/.test(char)) {
        throw new Error(`unexpected character "${char}" in variable name near "${firstLine(src)}"`);
      }
    }
    const key = sep > 0 ? src.slice(0, sep).trim() : "";
    if (key.length === 0) {
      throw new Error(
        `unexpected character "${src[0] ?? ""}" in variable name near "${firstLine(src)}"`,
      );
    }
    // `$VAR`/`${VAR}` references expand against variables defined earlier in the same file, so
    // assign in file order.
    const { value, rest } = extractVarValue(src.slice(sep + 1), result);
    result[key] = value;
    src = rest;
  }
  return result;
}

/** The first physical line of `src` (for error messages, without leaking the rest). */
function firstLine(src: string): string {
  const nl = src.indexOf("\n");
  return nl === -1 ? src : src.slice(0, nl);
}

/**
 * Advances past blank lines and whole `#` comment lines to the next statement start. Comments
 * are skipped before value scanning, so an apostrophe inside a comment never opens a quote.
 */
function skipToStatementStart(src: string): string {
  let i = 0;
  while (i < src.length) {
    const char = src[i]!;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      i++;
      continue;
    }
    if (char === "#") {
      const nl = src.indexOf("\n", i);
      if (nl === -1) return "";
      i = nl + 1;
      continue;
    }
    break;
  }
  return src.slice(i);
}

// Optional leading backslash, `$`, optional `(`, optional `{`, an optional `[A-Z0-9_]+` name,
// and an optional closing `}`.
const EXPAND_VAR_REGEX = /(\\)?(\$)(\()?\{?([A-Z0-9_]+)?\}?/g;

/**
 * Expands `$VAR`/`${VAR}` references. A leading backslash (`\$VAR`) or a `$(`-form is returned
 * with its first character dropped (no expansion / no command substitution); a matched
 * `[A-Z0-9_]+` name expands to `vars[name]` (undefined becomes empty string); a bare `$` with no
 * name is left unchanged.
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
 * Extracts a single dotenv value starting just after the `=`/`:`. Returns the parsed value and
 * the remaining buffer so the caller can continue scanning.
 *
 * A quoted value runs to its matching unescaped closing quote across newlines (so a multiline
 * PEM key parses as one value), discarding anything after the closing quote on that line. An
 * unquoted value runs to end of line, stripping the inline comment. Double-quoted values expand
 * `\n`/`\r` escapes then `$VAR` references; single-quoted values are literal.
 */
function extractVarValue(
  raw: string,
  vars: Record<string, string>,
): { value: string; rest: string } {
  // Left-trim spaces/tabs after `=` (not newlines) before the value.
  const value = raw.replace(/^[ \t]+/, "");
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    let end = -1;
    for (let i = 1; i < value.length; i++) {
      // The terminator is a matching quote not preceded by a backslash escape; the
      // scan crosses newlines, so a multiline quoted value closes on a later line.
      if (value[i] === quote && value[i - 1] !== "\\") {
        end = i;
        break;
      }
    }
    if (end === -1) {
      throw new Error("unterminated quoted value");
    }
    const inner = value.slice(1, end);
    // Discard anything between the closing quote and the next newline (trailing
    // comment); resume at that newline so the next statement is parsed cleanly.
    const afterQuote = value.slice(end + 1);
    const nl = afterQuote.indexOf("\n");
    const rest = nl === -1 ? "" : afterQuote.slice(nl);
    if (quote === '"') {
      // Double-quoted: expand escapes first, then variable references. `\n`/`\r` become real
      // newlines; a backslash before any other char (except `$`) is dropped, so `\$` survives
      // to suppress expansion.
      const escaped = inner
        .replaceAll("\\n", "\n")
        .replaceAll("\\r", "\r")
        .replace(/\\([^$])/g, "$1");
      return { value: expandVariables(escaped, vars), rest };
    }
    // Single-quoted values are taken literally (no escape or variable expansion).
    return { value: inner, rest };
  }
  // Unquoted values are single-line: run to the next newline, strip the inline
  // comment, trim, then expand variables.
  const nl = value.indexOf("\n");
  const lineValue = nl === -1 ? value : value.slice(0, nl);
  const rest = nl === -1 ? "" : value.slice(nl);
  return { value: expandVariables(stripInlineComment(lineValue).trim(), vars), rest };
}

/**
 * Strips an unquoted inline comment: a `#` preceded by whitespace begins a comment
 * (`54323 # local` → `54323`), while a `#` with no leading whitespace is part of the value
 * (`foo#bar`).
 */
function stripInlineComment(value: string): string {
  for (let i = value.length - 1; i > 0; i--) {
    if (value[i] === "#" && (value[i - 1] === " " || value[i - 1] === "\t")) {
      return value.slice(0, i);
    }
  }
  return value;
}
