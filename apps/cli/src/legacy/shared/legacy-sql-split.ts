/**
 * PostgreSQL statement splitter, ported 1:1 from `pkg/parser`
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

// `\p{Nd}` (decimal digits only), not `\p{N}` (all Unicode numbers): Go's
// `unicode.IsDigit` — what `isIdentifierRune`/`TagState.next` port — is an alias for
// category `Nd` alone, so it rejects `No`/`Nl` runes like superscript-2 (`²`) that
// `\p{N}` would wrongly accept as a valid identifier/dollar-tag character.
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
 * One raw token from {@link splitRaw}. `terminated` is `false` only for a
 * trailing statement emitted at EOF with no closing delimiter (the
 * `acc.length > 0` fallback below) — every other token was emitted because the
 * FSM itself found a boundary (a bare `;` in `ReadyState`, or `AtomicState`
 * closing). Only ever `false` on the LAST element `splitRaw` returns, since
 * that fallback fires at most once, after the main loop.
 */
interface RawToken {
  readonly text: string;
  readonly terminated: boolean;
}

/** The FSM traversal shared by every `legacySplitSql*` entry point below. */
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
 * Splits `sql` into raw statements (comments/whitespace preserved), then applies
 * the optional transforms to each. Mirrors `parser.Split`.
 */
export function legacySplitSql(
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

/** `parser.SplitAndTrim`'s per-token transform: trim trailing `;` then surrounding whitespace. */
const legacyTrimStatement = (token: string): string => token.replace(/;+$/u, "").trim();

/** Mirrors `parser.SplitAndTrim`: trim trailing `;` then surrounding whitespace. */
export function legacySplitAndTrim(sql: string): string[] {
  return legacySplitSql(sql, legacyTrimStatement);
}

/** One statement, paired with both its RAW and trimmed forms. */
export interface LegacySplitSqlToken {
  /** The exact text `legacySplitSql(sql)` (no transforms) would emit for this statement. */
  readonly raw: string;
  /** `legacyTrimStatement(raw)` — what `legacySplitAndTrim` emits, including when empty. */
  readonly trimmed: string;
  /**
   * `false` only for a trailing statement with no closing delimiter, emitted at
   * real EOF (`splitRaw`'s `acc.length > 0` fallback) — see {@link RawToken}.
   * `checkScannerBufferSize` (`legacy-migration-apply.ts`) needs this to decide
   * `>` vs `>=` against the effective buffer limit: `bufio.Scanner` can
   * only apply its too-long check (`len(s.buf) >= s.maxTokenSize`) once it has
   * given up looking for a delimiter and still needs more data — for a
   * delimiter-terminated token the delimiter is found (and the token emitted)
   * in the SAME `Scan()` call that fills the buffer to capacity, before that
   * check is ever reached, so a token exactly AT the limit still succeeds. An
   * unterminated trailing token has no delimiter to find: once the buffer
   * fills to the effective limit without one, the too-long check fires
   * immediately — there's never a chance to attempt the extra `Read()` that would
   * reveal real EOF and let the split function emit the trailing token
   * instead. Verified empirically against `pkg/parser.Split`: a
   * single terminated statement of exactly `maxbuf` bytes always succeeds,
   * while an unterminated one of exactly `maxbuf` bytes always fails with
   * `bufio.ErrTooLong` (one byte under still succeeds; one byte over always
   * fails either way).
   */
  readonly terminated: boolean;
}

/**
 * Same FSM traversal as {@link legacySplitAndTrim}, but pairs each statement's RAW
 * (pre-trim) text with its trimmed form instead of discarding the raw text once
 * emitted. `bufio.Scanner`-based `parser.Split`
 * enforces `SUPABASE_SCANNER_BUFFER_SIZE` against the untransformed
 * `scanner.Text()` — the RAW form — and its `bufio.ErrTooLong` message reports
 * that same raw text for the LAST successfully scanned statement, so a caller
 * replicating that check (`legacy-migration-apply.ts`'s `execMigrationBatch`)
 * needs both forms, not just the trimmed one `legacySplitAndTrim` returns.
 *
 * Unlike `legacySplitSql`/`legacySplitAndTrim`, this does NOT drop a statement
 * whose trimmed form is empty — callers that replicate `len(stats)` counter
 * (which only increments for a non-empty trimmed statement) need to see every raw
 * token, including the ones `legacySplitAndTrim` itself would filter out.
 */
export function legacySplitSqlTokens(sql: string): ReadonlyArray<LegacySplitSqlToken> {
  return splitRaw(sql).map(({ text: raw, terminated }) => ({
    raw,
    trimmed: legacyTrimStatement(raw),
    terminated,
  }));
}

// `(?i)drop\s+` — `dropStatementPattern`.
const DROP_STATEMENT_PATTERN = /drop\s+/i;

/**
 * Extracts DROP statements from a schema diff for the safety warning shown by
 * `db diff` / `db pull` / declarative `sync`. Mirrors `findDropStatements`:
 * split the SQL into statements, then keep those matching `(?i)drop\s+`.
 */
export function legacyFindDropStatements(sql: string): ReadonlyArray<string> {
  return legacySplitAndTrim(sql).filter((statement) => DROP_STATEMENT_PATTERN.test(statement));
}
