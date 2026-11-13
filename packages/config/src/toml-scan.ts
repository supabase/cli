// Character-level TOML scanner. Produces top-level tokens in document order: blank lines,
// comments, table headers, and key-value lines (multi-line arrays/strings scanned as single
// opaque spans). Never throws — an unrecognized construct yields an `{ error }` result instead.

export interface TomlHeaderToken {
  readonly kind: "header";
  readonly start: number;
  readonly end: number;
  readonly path: ReadonlyArray<string>;
  readonly isArrayOfTables: boolean;
  /** Offset just past the dotted key path, before any whitespace and the closing bracket. */
  readonly keysEnd: number;
  /** Offset of a same-line `#` after the closing bracket. */
  readonly commentStart?: number;
}

interface TomlSpan {
  readonly start: number;
  readonly end: number;
}

export interface TomlKeyToken {
  readonly kind: "kv";
  readonly start: number;
  readonly end: number;
  /** Fully qualified: the enclosing table's path plus this key's own (possibly dotted) segments. */
  readonly path: ReadonlyArray<string>;
  readonly tableIndex: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  /** True when this key's OWN value is an inline table (`{ ... }`) — see `findInlineTableOnPath`. */
  readonly insideInlineTable: boolean;
  /** Offset of a same-line `#` after the value. */
  readonly commentStart?: number;
  /** Comments inside a multi-line array or inline-table value. */
  readonly valueComments: ReadonlyArray<TomlSpan>;
}

interface TomlBlankToken {
  readonly kind: "blank";
  readonly start: number;
  readonly end: number;
}

interface TomlCommentToken {
  readonly kind: "comment";
  readonly start: number;
  readonly end: number;
}

export type TomlToken = TomlHeaderToken | TomlKeyToken | TomlBlankToken | TomlCommentToken;

export interface TomlScanResult {
  readonly source: string;
  readonly tokens: ReadonlyArray<TomlToken>;
  readonly headers: ReadonlyArray<TomlHeaderToken>;
  readonly newline: "\n" | "\r\n";
  readonly endsWithNewline: boolean;
}

export interface TomlScanError {
  readonly error: string;
  readonly offset: number;
}

function charAt(source: string, pos: number): string {
  const ch = source[pos];
  return ch ?? "";
}

export function skipInlineWhitespace(source: string, pos: number): number {
  let cursor = pos;
  while (cursor < source.length && (source[cursor] === " " || source[cursor] === "\t")) {
    cursor++;
  }
  return cursor;
}

function skipToEndOfLine(source: string, pos: number): number {
  let cursor = pos;
  while (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") {
    cursor++;
  }
  return cursor;
}

function advancePastNewline(source: string, pos: number): number {
  if (source[pos] === "\r" && source[pos + 1] === "\n") {
    return pos + 2;
  }
  if (source[pos] === "\n" || source[pos] === "\r") {
    return pos + 1;
  }
  return pos;
}

function scanBasicString(source: string, pos: number): number | null {
  let cursor = pos;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === "\\") {
      cursor += 2;
      continue;
    }
    if (ch === '"') {
      return cursor + 1;
    }
    if (ch === "\n" || ch === "\r") {
      return null;
    }
    cursor++;
  }
  return null;
}

function scanLiteralString(source: string, pos: number): number | null {
  let cursor = pos;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === "'") {
      return cursor + 1;
    }
    if (ch === "\n" || ch === "\r") {
      return null;
    }
    cursor++;
  }
  return null;
}

function scanMultilineBasicString(source: string, pos: number): number | null {
  let cursor = pos;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === "\\") {
      cursor += 2;
      continue;
    }
    if (ch === '"' && source.startsWith('"""', cursor)) {
      cursor += 3;
      let extra = 0;
      while (extra < 2 && source[cursor] === '"') {
        cursor++;
        extra++;
      }
      return cursor;
    }
    cursor++;
  }
  return null;
}

function scanMultilineLiteralString(source: string, pos: number): number | null {
  let cursor = pos;
  while (cursor < source.length) {
    if (source[cursor] === "'" && source.startsWith("'''", cursor)) {
      cursor += 3;
      let extra = 0;
      while (extra < 2 && source[cursor] === "'") {
        cursor++;
        extra++;
      }
      return cursor;
    }
    cursor++;
  }
  return null;
}

function scanBareValue(source: string, pos: number): number {
  let cursor = pos;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === "#" || ch === "\n" || ch === "\r") {
      break;
    }
    cursor++;
  }
  // Trailing inline whitespace before a `#` comment (or EOL) belongs to the comment/line-ending,
  // not the value: without this, replacing a value would fold that space into the replaced span
  // and eat it.
  while (cursor > pos && (source[cursor - 1] === " " || source[cursor - 1] === "\t")) {
    cursor--;
  }
  return cursor;
}

/** Scans a bracketed value (array or inline table), tracking nested strings/brackets so an
 * unrelated `]`/`}`/`#` inside a string never terminates the scan early. `openChar`/`closeChar`
 * select array (`[`/`]`) or inline-table (`{`/`}`) matching; a `#` outside a string starts a
 * comment that is skipped and, when `comments` is given, recorded. */
function scanBracketedValue(
  source: string,
  pos: number,
  openChar: string,
  closeChar: string,
  comments?: Array<TomlSpan>,
): number | null {
  let cursor = pos;
  let depth = 1;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === '"') {
      const next = source.startsWith('"""', cursor)
        ? scanMultilineBasicString(source, cursor + 3)
        : scanBasicString(source, cursor + 1);
      if (next === null) {
        return null;
      }
      cursor = next;
      continue;
    }
    if (ch === "'") {
      const next = source.startsWith("'''", cursor)
        ? scanMultilineLiteralString(source, cursor + 3)
        : scanLiteralString(source, cursor + 1);
      if (next === null) {
        return null;
      }
      cursor = next;
      continue;
    }
    if (ch === "#") {
      const commentEnd = skipToEndOfLine(source, cursor);
      comments?.push({ start: cursor, end: commentEnd });
      cursor = advancePastNewline(source, commentEnd);
      continue;
    }
    if (ch === openChar) {
      depth++;
      cursor++;
      continue;
    }
    if (ch === closeChar) {
      depth--;
      cursor++;
      if (depth === 0) {
        return cursor;
      }
      continue;
    }
    cursor++;
  }
  return null;
}

function scanValue(source: string, start: number, comments?: Array<TomlSpan>): number | null {
  const ch = charAt(source, start);
  if (ch === '"') {
    return source.startsWith('"""', start)
      ? scanMultilineBasicString(source, start + 3)
      : scanBasicString(source, start + 1);
  }
  if (ch === "'") {
    return source.startsWith("'''", start)
      ? scanMultilineLiteralString(source, start + 3)
      : scanLiteralString(source, start + 1);
  }
  if (ch === "[") {
    return scanBracketedValue(source, start + 1, "[", "]", comments);
  }
  if (ch === "{") {
    return scanBracketedValue(source, start + 1, "{", "}", comments);
  }
  if (ch === "") {
    return null;
  }
  return scanBareValue(source, start);
}

const BARE_KEY_CHAR = /^[A-Za-z0-9_-]$/;

function hexCodePoint(raw: string, start: number, length: number): string | null {
  const hex = raw.slice(start, start + length);
  const value = Number.parseInt(hex, 16);
  return new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(hex) &&
    value <= 0x10ffff &&
    (value < 0xd800 || value > 0xdfff)
    ? String.fromCodePoint(value)
    : null;
}

/** Decodes a basic-string key segment, or returns null when an escape is invalid TOML. */
function unescapeBasicString(raw: string): string | null {
  let result = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "\\") {
      result += ch ?? "";
      continue;
    }
    const next = raw[i + 1];
    if (next === "\\" || next === '"') {
      result += next;
      i++;
    } else if (next === "b") {
      result += "\b";
      i++;
    } else if (next === "f") {
      result += "\f";
      i++;
    } else if (next === "n") {
      result += "\n";
      i++;
    } else if (next === "r") {
      result += "\r";
      i++;
    } else if (next === "t") {
      result += "\t";
      i++;
    } else if (next === "e") {
      result += "\u001b";
      i++;
    } else if (next === "x" || next === "u" || next === "U") {
      const length = next === "x" ? 2 : next === "u" ? 4 : 8;
      const decoded = hexCodePoint(raw, i + 2, length);
      if (decoded === null) {
        return null;
      }
      result += decoded;
      i += length + 1;
    } else {
      return null;
    }
  }
  return result;
}

interface DottedKeyScan {
  readonly segments: ReadonlyArray<string>;
  readonly end: number;
}

/** Parses one or more dot-separated key segments (bare, basic-quoted, or literal-quoted),
 * used for both table headers (`[a."b.c"]`) and key-value lines (`a."b.c" = 1`). Stops as soon
 * as no further `.`-continuation is found; the caller checks for the expected terminator
 * (`]` or `=`) itself. */
function scanDottedKeyPath(source: string, pos: number): DottedKeyScan | null {
  const segments: Array<string> = [];
  let cursor = pos;
  for (;;) {
    cursor = skipInlineWhitespace(source, cursor);
    const ch = charAt(source, cursor);
    if (ch === '"') {
      const strEnd = scanBasicString(source, cursor + 1);
      if (strEnd === null) {
        return null;
      }
      const segment = unescapeBasicString(source.slice(cursor + 1, strEnd - 1));
      if (segment === null) {
        return null;
      }
      segments.push(segment);
      cursor = strEnd;
    } else if (ch === "'") {
      const strEnd = scanLiteralString(source, cursor + 1);
      if (strEnd === null) {
        return null;
      }
      segments.push(source.slice(cursor + 1, strEnd - 1));
      cursor = strEnd;
    } else if (BARE_KEY_CHAR.test(ch)) {
      let bareEnd = cursor;
      while (BARE_KEY_CHAR.test(charAt(source, bareEnd))) {
        bareEnd++;
      }
      segments.push(source.slice(cursor, bareEnd));
      cursor = bareEnd;
    } else {
      return null;
    }
    const afterSegment = skipInlineWhitespace(source, cursor);
    if (charAt(source, afterSegment) === ".") {
      cursor = afterSegment + 1;
      continue;
    }
    cursor = afterSegment;
    break;
  }
  return { segments, end: cursor };
}

export function scanTomlDocument(source: string): TomlScanResult | TomlScanError {
  const tokens: Array<TomlToken> = [];
  const headers: Array<TomlHeaderToken> = [];
  const length = source.length;
  let pos = 0;
  let currentTableIndex = -1;
  let currentTablePath: ReadonlyArray<string> = [];

  while (pos < length) {
    const lineStart = pos;
    const firstNonWhitespace = skipInlineWhitespace(source, pos);
    const ch = charAt(source, firstNonWhitespace);

    if (ch === "" || ch === "\n" || ch === "\r") {
      const end = advancePastNewline(source, firstNonWhitespace);
      tokens.push({ kind: "blank", start: lineStart, end });
      pos = end === firstNonWhitespace ? length : end;
      continue;
    }

    if (ch === "#") {
      const end = advancePastNewline(source, skipToEndOfLine(source, firstNonWhitespace));
      tokens.push({ kind: "comment", start: lineStart, end });
      pos = end;
      continue;
    }

    if (ch === "[") {
      const isArrayOfTables = charAt(source, firstNonWhitespace + 1) === "[";
      const keyStart = firstNonWhitespace + (isArrayOfTables ? 2 : 1);
      const parsedPath = scanDottedKeyPath(source, keyStart);
      if (parsedPath === null || parsedPath.segments.length === 0) {
        return { error: "malformed table header", offset: lineStart };
      }
      let closeCursor = parsedPath.end;
      if (charAt(source, closeCursor) !== "]") {
        return { error: "malformed table header", offset: lineStart };
      }
      closeCursor += 1;
      if (isArrayOfTables) {
        if (charAt(source, closeCursor) !== "]") {
          return { error: "malformed array-of-tables header", offset: lineStart };
        }
        closeCursor += 1;
      }
      const afterHeader = skipInlineWhitespace(source, closeCursor);
      const headerComment = charAt(source, afterHeader) === "#" ? afterHeader : undefined;
      const end = advancePastNewline(source, skipToEndOfLine(source, closeCursor));
      const headerToken: TomlHeaderToken = {
        kind: "header",
        start: lineStart,
        end,
        path: parsedPath.segments,
        isArrayOfTables,
        keysEnd: parsedPath.end,
        ...(headerComment === undefined ? {} : { commentStart: headerComment }),
      };
      headers.push(headerToken);
      tokens.push(headerToken);
      currentTableIndex = headers.length - 1;
      currentTablePath = parsedPath.segments;
      pos = end;
      continue;
    }

    const parsedKey = scanDottedKeyPath(source, firstNonWhitespace);
    if (parsedKey === null || parsedKey.segments.length === 0) {
      return { error: "malformed key-value line", offset: lineStart };
    }
    const afterKey = skipInlineWhitespace(source, parsedKey.end);
    if (charAt(source, afterKey) !== "=") {
      return { error: "malformed key-value line", offset: lineStart };
    }
    const valueStart = skipInlineWhitespace(source, afterKey + 1);
    const valueComments: Array<TomlSpan> = [];
    const valueEndRaw = scanValue(source, valueStart, valueComments);
    if (valueEndRaw === null) {
      return { error: "unterminated value", offset: valueStart };
    }
    const afterValue = skipInlineWhitespace(source, valueEndRaw);
    const valueComment = charAt(source, afterValue) === "#" ? afterValue : undefined;
    const end = advancePastNewline(source, skipToEndOfLine(source, valueEndRaw));
    const fullPath = [...currentTablePath, ...parsedKey.segments];
    const rawValueText = source.slice(valueStart, valueEndRaw);
    tokens.push({
      kind: "kv",
      start: lineStart,
      end,
      path: fullPath,
      tableIndex: currentTableIndex,
      valueStart,
      valueEnd: valueEndRaw,
      insideInlineTable: rawValueText.startsWith("{"),
      valueComments,
      ...(valueComment === undefined ? {} : { commentStart: valueComment }),
    });
    pos = end;
  }

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  // A mixed-EOL file may be detected as CRLF overall (because some earlier line uses it) while
  // its final line ends in a bare `\n`; checking for `"\n"` alone (rather than the detected
  // flavor) covers both terminators, since a `"\r\n"`-ending string always also ends in `"\n"`.
  return { source, tokens, headers, newline, endsWithNewline: source.endsWith("\n") };
}

export interface TomlArrayLayout {
  readonly items: ReadonlyArray<{
    readonly leading: ReadonlyArray<TomlSpan>;
    readonly trailing?: TomlSpan;
  }>;
  readonly tail: ReadonlyArray<TomlSpan>;
}

/** Maps the comments of a scalar-only array to its elements: a comment on its own line leads the
 * next element, one sharing a line with an element trails it, and any after the last element form the tail. */
export function scanScalarArrayLayout(
  source: string,
  valueStart: number,
  valueEnd: number,
): TomlArrayLayout | null {
  const items: Array<{ leading: Array<TomlSpan>; trailing?: TomlSpan }> = [];
  let pending: Array<TomlSpan> = [];
  let sameLine = false;
  let cursor = valueStart + 1;
  const close = valueEnd - 1;
  while (cursor < close) {
    const ch = charAt(source, cursor);
    if (ch === "\n" || ch === "\r") {
      sameLine = false;
      cursor++;
    } else if (ch === " " || ch === "\t" || ch === ",") {
      cursor++;
    } else if (ch === "#") {
      const end = skipToEndOfLine(source, cursor);
      const last = items[items.length - 1];
      if (sameLine && last !== undefined) {
        last.trailing = { start: cursor, end };
      } else {
        pending.push({ start: cursor, end });
      }
      cursor = end;
    } else {
      let end: number | null = cursor;
      if (ch === '"' || ch === "'") {
        end = scanValue(source, cursor);
      } else {
        while (end < close && !/[,#\s\]]/.test(charAt(source, end))) {
          end++;
        }
      }
      if (end === null) {
        return null;
      }
      items.push({ leading: pending });
      pending = [];
      sameLine = true;
      cursor = end;
    }
  }
  return { items, tail: pending };
}
