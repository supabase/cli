/**
 * PostgreSQL statement splitter, ported 1:1 from Go's `pkg/parser`
 * (`token.go` + `state.go`). A finite-state machine tracks string literals
 * (`'…'`, `"…"`), line/block comments, dollar-quoted bodies (`$tag$…$tag$`),
 * backslash escapes, and `BEGIN ATOMIC … END` / parenthesised bodies, so a `;`
 * inside any of those is not mistaken for a statement separator. This matters
 * for declarative diffs, which contain `CREATE FUNCTION` bodies full of `;`.
 *
 * Operates on Unicode code points (JS strings) rather than raw bytes; for the
 * ASCII delimiters the FSM keys on (`/*`, `*​/`, `;`, quotes, `$`), suffix
 * comparison is identical to Go's byte-window logic.
 */

interface State {
  /** Returns the next state, or `null` to emit a token (statement boundary). */
  next(rune: string, data: string): State | null;
}

const BEGIN_ATOMIC = "ATOMIC";
const END_ATOMIC = "END";

const isIdentifierRune = (rune: string): boolean => /[\p{L}\p{N}_$]/u.test(rune);

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
    // Valid dollar-tag characters.
    if (/[\p{L}\p{N}_]/u.test(rune)) return this;
    return new ReadyState().next(rune, data);
  }
}

class EscapeState implements State {
  next(): State | null {
    return new ReadyState();
  }
}

class AtomicState implements State {
  constructor(
    private prev: State,
    private readonly delimiter: string,
  ) {}
  next(rune: string, data: string): State | null {
    // A delimiter inside a nested quote/comment doesn't count.
    const curr = this.prev.next(rune, data);
    if (curr !== null) this.prev = curr;
    if (this.prev instanceof ReadyState) {
      const window = data.slice(-this.delimiter.length);
      if (window.toUpperCase() === this.delimiter.toUpperCase()) return new ReadyState();
    }
    return this;
  }
}

/**
 * Splits `sql` into raw statements (comments/whitespace preserved), then applies
 * the optional transforms to each. Mirrors Go's `parser.Split`.
 */
export function legacySplitSql(
  sql: string,
  ...transform: ReadonlyArray<(s: string) => string>
): string[] {
  let state: State = new ReadyState();
  const statements: string[] = [];
  let acc = "";
  for (const rune of Array.from(sql)) {
    acc += rune;
    const next = state.next(rune, acc);
    if (next === null) {
      let token = acc;
      for (const apply of transform) token = apply(token);
      if (token.length > 0) statements.push(token);
      acc = "";
      state = new ReadyState();
    } else {
      state = next;
    }
  }
  // Trailing non-terminated statement at EOF.
  if (acc.length > 0) {
    let token = acc;
    for (const apply of transform) token = apply(token);
    if (token.length > 0) statements.push(token);
  }
  return statements;
}

/** Mirrors Go's `parser.SplitAndTrim`: trim trailing `;` then surrounding whitespace. */
export function legacySplitAndTrim(sql: string): string[] {
  return legacySplitSql(
    sql,
    (token) => token.replace(/;+$/u, ""),
    (token) => token.trim(),
  );
}

// `(?i)drop\s+` — Go's `dropStatementPattern` (`internal/db/diff/diff.go:100`,
// also `internal/db/declarative/declarative.go:62`).
const DROP_STATEMENT_PATTERN = /drop\s+/i;

/**
 * Extracts DROP statements from a schema diff for the safety warning shown by
 * `db diff` / `db pull` / declarative `sync`. Mirrors Go's `findDropStatements`:
 * split the SQL into statements, then keep those matching `(?i)drop\s+`.
 */
export function legacyFindDropStatements(sql: string): ReadonlyArray<string> {
  return legacySplitAndTrim(sql).filter((statement) => DROP_STATEMENT_PATTERN.test(statement));
}
