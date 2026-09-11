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

// `\p{Nd}` (decimal digits only), not `\p{N}` (all Unicode numbers): `\p{N}` would wrongly
// accept `No`/`Nl` runes like superscript-2 (`²`) as a valid identifier/dollar-tag character.
const isIdentifierRune = (rune: string): boolean => /[\p{L}\p{Nd}_$]/u.test(rune);

function isBeginAtomic(data: string): boolean {
  let offset = data.length - BEGIN_ATOMIC.length;
  if (offset < 0 || data.slice(offset).toUpperCase() !== BEGIN_ATOMIC) return false;
  if (offset > 0 && isIdentifierRune(data[offset - 1]!)) return false;
  const prefix = data.slice(0, offset).replace(/\s+$/u, "");
  offset = prefix.length - "BEGIN".length;
  if (offset < 0 || prefix.slice(offset).toUpperCase() !== "BEGIN") return false;
  if (offset === 0) return true;
  return !isIdentifierRune(prefix[offset - 1]!);
}

class ReadyState implements State {
  next(rune: string, data: string): State | null {
    switch (rune) {
      case "$":
        return new TagState(data.length - rune.length);
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
        return new AtomicState(new ReadyState(), ")");
      case "c":
      case "C":
        if (isBeginAtomic(data)) return new AtomicState(new ReadyState(), END_ATOMIC);
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
    // Valid dollar-tag characters — see `isIdentifierRune`'s comment on why `\p{Nd}`,
    // not `\p{N}`.
    if (/[\p{L}\p{Nd}_]/u.test(rune)) return this;
    return new ReadyState().next(rune, data);
  }
}

class EscapeState implements State {
  next(): State | null {
    return new ReadyState();
  }
}

class AtomicState implements State {
  // A keyword delimiter (END) matched at an identifier boundary; the body only closes once
  // the next rune shows it is not the start of a longer identifier such as `endpoint`.
  private closing = false;
  constructor(
    private prev: State,
    private readonly delimiter: string,
  ) {}
  next(rune: string, data: string): State | null {
    if (this.closing) {
      this.closing = false;
      // END confirmed: the rune after it belongs to the ready state.
      if (!isIdentifierRune(rune)) return new ReadyState().next(rune, data);
    }
    // A delimiter inside a nested quote/comment doesn't count.
    const curr = this.prev.next(rune, data);
    if (curr !== null) this.prev = curr;
    if (this.prev instanceof ReadyState && this.endsWithDelimiter(data)) {
      // Punctuation delimiters such as `)` close immediately.
      if (!isIdentifierRune(this.delimiter[0]!)) return new ReadyState();
      this.closing = true;
    }
    return this;
  }
  /**
   * Whether `data` ends with the delimiter. A keyword delimiter must also start at an
   * identifier boundary, so a column named `pending` does not close a `BEGIN ATOMIC` body;
   * `isBeginAtomic` applies the same rule to the opener.
   */
  private endsWithDelimiter(data: string): boolean {
    const offset = data.length - this.delimiter.length;
    const delimiter = this.delimiter.toUpperCase();
    if (offset < 0 || data.slice(offset).toUpperCase() !== delimiter) return false;
    if (offset === 0 || !isIdentifierRune(this.delimiter[0]!)) return true;
    return !isIdentifierRune(data[offset - 1]!);
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
