/**
 * PostgreSQL statement splitter. A finite-state machine tracks string literals, comments,
 * dollar-quoted bodies (`$tag$…$tag$`), backslash escapes, and `BEGIN ATOMIC … END`/
 * parenthesised bodies, so a `;` inside any of those isn't mistaken for a statement
 * separator — this matters for declarative diffs, whose `CREATE FUNCTION` bodies are full of `;`.
 *
 * Operates on Unicode code points (JS strings), not raw bytes.
 */

interface State {
  /** Returns the next state, or `null` to emit a token (statement boundary). */
  next(char: string, data: string): State | null;
}

const BEGIN_ATOMIC = "ATOMIC";
const END_ATOMIC = "END";

// PostgreSQL's scan.l treats every code point at or above 0x80 as an identifier/dollar-tag
// character (`ident_cont`/`dolq_cont`), whatever its Unicode category.
const isIdentifierChar = (char: string): boolean => {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && (codePoint >= 0x80 || /[A-Za-z0-9_$]/u.test(char));
};

// A code point spans at most two UTF-16 units, so the last one before `offset` lies within
// the preceding two.
const hasIdentifierCharBefore = (data: string, offset: number): boolean => {
  if (offset <= 0) return false;
  const char = Array.from(data.slice(Math.max(0, offset - 2), offset)).at(-1);
  return char !== undefined && isIdentifierChar(char);
};

const asciiUpper = (text: string): string => text.replace(/[a-z]/g, (c) => c.toUpperCase());

function endsWithKeyword(data: string, keyword: string): boolean {
  const offset = data.length - keyword.length;
  if (offset < 0 || asciiUpper(data.slice(offset)) !== keyword) return false;
  return !hasIdentifierCharBefore(data, offset);
}

const isSqlWhitespace = (char: string): boolean => " \t\n\r\f\v".includes(char);

// scan.l `newline`: a `--` comment ends at either.
const isNewline = (char: string): boolean => char === "\n" || char === "\r";

function isBeginAtomic(data: string): boolean {
  if (!endsWithKeyword(data, BEGIN_ATOMIC)) return false;
  let end = data.length - BEGIN_ATOMIC.length;
  while (end > 0 && isSqlWhitespace(data[end - 1]!)) end -= 1;
  return endsWithKeyword(data.slice(0, end), "BEGIN");
}

function isCommentsAndWhitespace(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    if (isSqlWhitespace(text[i]!)) {
      i += 1;
    } else if (text.startsWith("--", i)) {
      const newline = text.slice(i + 2).search(/[\n\r]/u);
      if (newline === -1) return true;
      i += newline + 3;
    } else if (text.startsWith("/*", i)) {
      // Match `BlockState`'s sliding-window scan so both agree on overlapping delimiters.
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        const window = text.slice(i - 1, i + 1);
        if (window === "/*") depth += 1;
        else if (window === "*/") depth -= 1;
        i += 1;
      }
      if (depth > 0) return true;
    } else {
      return false;
    }
  }
  return true;
}

class ReadyState implements State {
  next(char: string, data: string): State | null {
    switch (char) {
      case "$": {
        // A `$` after an identifier char continues the identifier (`pending$$foo$`), not a
        // dollar quote. A digit counts too (`1$$`), unlike PostgreSQL; valid SQL never has that.
        const offset = data.length - char.length;
        if (hasIdentifierCharBefore(data, offset)) return this;
        return new TagState(offset);
      }
      case "'":
        // `E'…'` is an escape string constant only when the `E` starts a token (scan.l
        // `xestart`); in `type'…'` it ends an identifier. A digit or `$` before the `E`
        // counts as one too, unlike PostgreSQL; valid SQL never has that.
        return new QuoteState(char, endsWithKeyword(data.slice(0, -1), "E"));
      case '"':
        return new QuoteState(char, false);
      case "-":
        return new CommentState();
      case "/":
        return new BlockState();
      case "\\":
        return new EscapeState();
      case ";":
        return null;
      case "(":
        return new ParenState(new ReadyState());
      case "c":
      case "C":
        if (isBeginAtomic(data)) return new AtomicState(new ReadyState(), data.length);
        return this;
      default:
        return this;
    }
  }
}

class CommentState implements State {
  next(char: string, data: string): State | null {
    if (char === "-") return new LineCommentState();
    return new ReadyState().next(char, data);
  }
}

class LineCommentState implements State {
  next(char: string): State {
    return isNewline(char) ? new ReadyState() : this;
  }
}

class BlockState implements State {
  private depth = 0;
  next(char: string, data: string): State | null {
    const window = data.slice(-2);
    if (window === "/*") {
      this.depth += 1;
      return this;
    }
    if (this.depth === 0) return new ReadyState().next(char, data);
    if (window === "*/") {
      this.depth -= 1;
      if (this.depth === 0) return new ReadyState();
    }
    return this;
  }
}

class QuoteState implements State {
  private escape = false;
  private backslash = false;
  constructor(
    private readonly delimiter: string,
    private readonly backslashEscapes: boolean,
  ) {}
  next(char: string, data: string): State | null {
    if (this.escape) {
      // Preserve a doubled quote ('' or "").
      if (char === this.delimiter) {
        this.escape = false;
        return this;
      }
      if (this.backslashEscapes) return new QuoteContinueState().next(char, data);
      return new ReadyState().next(char, data);
    }
    if (this.backslash) {
      // Preserve the char after a backslash (\' or \\).
      this.backslash = false;
      return this;
    }
    if (this.backslashEscapes && char === "\\") {
      this.backslash = true;
      return this;
    }
    if (char === this.delimiter) this.escape = true;
    return this;
  }
}

// After an escape string's closing quote, whitespace holding a newline and then a quote
// continues the same literal (scan.l `quotecontinue`); `--` comments count as whitespace.
class QuoteContinueState implements State {
  private newline = false;
  private dashes = 0;
  next(char: string, data: string): State | null {
    if (this.dashes === 2) {
      if (isNewline(char)) {
        this.dashes = 0;
        this.newline = true;
      }
      return this;
    }
    if (char === "-") {
      this.dashes += 1;
      return this;
    }
    if (this.dashes === 0) {
      if (isSqlWhitespace(char)) {
        this.newline ||= isNewline(char);
        return this;
      }
      if (this.newline && char === "'") return new QuoteState(char, true);
    }
    return new ReadyState().next(char, data);
  }
}

class DollarState implements State {
  constructor(private readonly delimiter: string) {}
  next(_char: string, data: string): State | null {
    if (data.slice(-this.delimiter.length) === this.delimiter) return new ReadyState();
    return this;
  }
}

class TagState implements State {
  constructor(private readonly offset: number) {}
  next(char: string, data: string): State | null {
    if (char === "$") return new DollarState(data.slice(this.offset));
    if (isIdentifierChar(char)) return this;
    return new ReadyState().next(char, data);
  }
}

class EscapeState implements State {
  next(): State | null {
    return new ReadyState();
  }
}

class ParenState implements State {
  constructor(private prev: State) {}
  next(char: string, data: string): State | null {
    const curr = this.prev.next(char, data);
    if (curr === null) {
      this.prev = new ReadyState();
      return this;
    }
    this.prev = curr;
    if (!(this.prev instanceof ReadyState)) return this;
    return char === ")" ? new ReadyState() : this;
  }
}

class AtomicState implements State {
  private pendingEnd = false;
  private statementStart: number;
  private statementHasContent = false;
  constructor(
    private prev: State,
    start: number,
  ) {
    this.statementStart = start;
  }
  next(char: string, data: string): State | null {
    const pendingEnd = this.pendingEnd;
    this.pendingEnd = false;
    if (pendingEnd && !isIdentifierChar(char)) return new ReadyState().next(char, data);
    // An `END` inside a nested quote/comment doesn't count.
    const curr = this.prev.next(char, data);
    if (curr === null) {
      this.prev = new ReadyState();
      this.statementStart = data.length;
      this.statementHasContent = false;
      return this;
    }
    this.prev = curr;
    if (!(this.prev instanceof ReadyState)) return this;
    // PostgreSQL requires each inner statement to end with `;`, so the closing `END` is
    // always the first token of a statement; a later `END` is expression text.
    if (!this.statementHasContent && endsWithKeyword(data, END_ATOMIC)) {
      if (
        isCommentsAndWhitespace(data.slice(this.statementStart, data.length - END_ATOMIC.length))
      ) {
        this.pendingEnd = true;
      } else {
        this.statementHasContent = true;
      }
    }
    return this;
  }
}

/**
 * One raw token from {@link splitRaw}. `terminated` is `false` only for a trailing
 * statement emitted at EOF with no closing delimiter — the FSM found a boundary for every
 * other token. Only ever `false` on the last element `splitRaw` returns.
 */
interface RawToken {
  readonly text: string;
  readonly terminated: boolean;
}

/** The FSM traversal shared by every `splitSql*` entry point below. */
function splitRaw(sql: string): RawToken[] {
  let state: State = new ReadyState();
  const tokens: RawToken[] = [];
  // Slice each token from `sql` instead of growing it with `+=`: states read the token's tail every
  // char, which would rebuild the whole string each time and go quadratic on large tokens. `data`
  // starts at the token, so offsets held by states are token-relative.
  let start = 0;
  let end = 0;
  for (const char of sql) {
    end += char.length;
    const data = sql.slice(start, end);
    const next = state.next(char, data);
    if (next === null) {
      tokens.push({ text: data, terminated: true });
      start = end;
      state = new ReadyState();
    } else {
      state = next;
    }
  }
  // Trailing non-terminated statement at EOF.
  if (end > start) tokens.push({ text: sql.slice(start), terminated: false });
  return tokens;
}

/**
 * Splits `sql` into raw statements (comments/whitespace preserved), then applies the
 * optional transforms to each.
 */
export function splitSql(
  sql: string,
  ...transform: ReadonlyArray<(s: string) => string>
): string[] {
  const statements: string[] = [];
  for (const { text: raw } of splitRaw(sql)) {
    let token = raw;
    for (const apply of transform) token = apply(token);
    if (token.length > 0) statements.push(token);
  }
  return statements;
}

/** Per-token transform: trim trailing `;` then surrounding whitespace. */
const trimStatement = (token: string): string => token.replace(/;+$/u, "").trim();

/** Trims trailing `;` then surrounding whitespace from each statement. */
export function splitAndTrim(sql: string): string[] {
  return splitSql(sql, trimStatement);
}

/** One statement, paired with both its raw and trimmed forms. */
export interface SplitSqlToken {
  /** The exact text `splitSql(sql)` (no transforms) would emit for this statement. */
  readonly raw: string;
  /** `trimStatement(raw)` — what `splitAndTrim` emits, including when empty. */
  readonly trimmed: string;
  /**
   * `false` only for a trailing statement with no closing delimiter, emitted at real EOF —
   * see {@link RawToken}. `checkScannerBufferSize` needs this to decide `>` vs `>=` against
   * the effective buffer limit: a delimiter-terminated token exactly at the limit still
   * succeeds (the delimiter is found before the too-long check is reached), while an
   * unterminated one exactly at the limit always fails.
   */
  readonly terminated: boolean;
}

/**
 * Same FSM traversal as {@link splitAndTrim}, but pairs each statement's raw (pre-trim) text
 * with its trimmed form, since `SUPABASE_SCANNER_BUFFER_SIZE` enforcement needs the raw form.
 *
 * Unlike `splitSql`/`splitAndTrim`, this does not drop a statement whose trimmed form is
 * empty, so callers counting only non-empty trimmed statements still see every raw token.
 */
export function splitSqlTokens(sql: string): ReadonlyArray<SplitSqlToken> {
  return splitRaw(sql).map(({ text: raw, terminated }) => ({
    raw,
    trimmed: trimStatement(raw),
    terminated,
  }));
}

// Case-insensitive: matches "drop" followed by whitespace.
const DROP_STATEMENT_PATTERN = /drop\s+/i;

/**
 * Extracts DROP statements from a schema diff for the safety warning shown by `db diff`,
 * `db pull`, and declarative `sync`.
 */
export function findDropStatements(sql: string): ReadonlyArray<string> {
  return splitAndTrim(sql).filter((statement) => DROP_STATEMENT_PATTERN.test(statement));
}
