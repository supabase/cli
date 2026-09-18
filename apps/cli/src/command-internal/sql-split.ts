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
  next(rune: string, data: string): State | null;
}

const BEGIN_ATOMIC = "ATOMIC";
const END_ATOMIC = "END";

// PostgreSQL's scan.l treats every code point at or above 0x80 as an identifier/dollar-tag
// character (`ident_cont`/`dolq_cont`), whatever its Unicode category.
const isIdentifierRune = (rune: string): boolean => {
  const codePoint = rune.codePointAt(0);
  return codePoint !== undefined && (codePoint >= 0x80 || /[A-Za-z0-9_$]/u.test(rune));
};

// A code point spans at most two UTF-16 units, so the last one before `offset` lies within
// the preceding two.
const hasIdentifierRuneBefore = (data: string, offset: number): boolean => {
  if (offset <= 0) return false;
  const rune = Array.from(data.slice(Math.max(0, offset - 2), offset)).at(-1);
  return rune !== undefined && isIdentifierRune(rune);
};

const asciiUpper = (text: string): string => text.replace(/[a-z]/g, (c) => c.toUpperCase());

function endsWithKeyword(data: string, keyword: string): boolean {
  const offset = data.length - keyword.length;
  if (offset < 0 || asciiUpper(data.slice(offset)) !== keyword) return false;
  return !hasIdentifierRuneBefore(data, offset);
}

const isSqlWhitespace = (rune: string): boolean => " \t\n\r\f\v".includes(rune);

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
      const newline = text.indexOf("\n", i + 2);
      if (newline === -1) return true;
      i = newline + 1;
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
  next(rune: string, data: string): State | null {
    switch (rune) {
      case "$": {
        // A `$` after an identifier rune continues the identifier (`pending$$foo$`), not a
        // dollar quote. A digit counts too (`1$$`), unlike PostgreSQL; valid SQL never has that.
        const offset = data.length - rune.length;
        if (hasIdentifierRuneBefore(data, offset)) return this;
        return new TagState(offset);
      }
      case "'":
      case '"':
        return new QuoteState(rune);
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
  next(rune: string, data: string): State | null {
    // A line comment escapes nothing until the newline — same shape as a dollar quote.
    if (rune === "-") return new DollarState("\n");
    return new ReadyState().next(rune, data);
  }
}

class BlockState implements State {
  private depth = 0;
  next(rune: string, data: string): State | null {
    const window = data.slice(-2);
    if (window === "/*") {
      this.depth += 1;
      return this;
    }
    if (this.depth === 0) return new ReadyState().next(rune, data);
    if (window === "*/") {
      this.depth -= 1;
      if (this.depth === 0) return new ReadyState();
    }
    return this;
  }
}

class QuoteState implements State {
  private escape = false;
  constructor(private readonly delimiter: string) {}
  next(rune: string, data: string): State | null {
    if (this.escape) {
      // Preserve a doubled quote ('' or "").
      if (rune === this.delimiter) {
        this.escape = false;
        return this;
      }
      return new ReadyState().next(rune, data);
    }
    if (rune === this.delimiter) this.escape = true;
    return this;
  }
}

class DollarState implements State {
  constructor(private readonly delimiter: string) {}
  next(_rune: string, data: string): State | null {
    if (data.slice(-this.delimiter.length) === this.delimiter) return new ReadyState();
    return this;
  }
}

class TagState implements State {
  constructor(private readonly offset: number) {}
  next(rune: string, data: string): State | null {
    if (rune === "$") return new DollarState(data.slice(this.offset));
    if (isIdentifierRune(rune)) return this;
    return new ReadyState().next(rune, data);
  }
}

class EscapeState implements State {
  next(): State | null {
    return new ReadyState();
  }
}

class ParenState implements State {
  constructor(private prev: State) {}
  next(rune: string, data: string): State | null {
    const curr = this.prev.next(rune, data);
    if (curr === null) {
      this.prev = new ReadyState();
      return this;
    }
    this.prev = curr;
    if (!(this.prev instanceof ReadyState)) return this;
    return rune === ")" ? new ReadyState() : this;
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
  next(rune: string, data: string): State | null {
    const pendingEnd = this.pendingEnd;
    this.pendingEnd = false;
    if (pendingEnd && !isIdentifierRune(rune)) return new ReadyState().next(rune, data);
    // An `END` inside a nested quote/comment doesn't count.
    const curr = this.prev.next(rune, data);
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
  let acc = "";
  for (const rune of Array.from(sql)) {
    acc += rune;
    const next = state.next(rune, acc);
    if (next === null) {
      tokens.push({ text: acc, terminated: true });
      acc = "";
      state = new ReadyState();
    } else {
      state = next;
    }
  }
  // Trailing non-terminated statement at EOF.
  if (acc.length > 0) tokens.push({ text: acc, terminated: false });
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
