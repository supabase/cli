import {
  splitAndTrimChecked,
  trimLeadingSqlComments,
} from "../../../command-internal/sql-split.ts";

export const READ_ONLY_STATEMENT_KEYWORDS = [
  "SELECT",
  "WITH",
  "VALUES",
  "TABLE",
  "SHOW",
  "EXPLAIN",
] as const;

const READ_STATEMENTS: ReadonlySet<string> = new Set(READ_ONLY_STATEMENT_KEYWORDS);

// Reported violations use these fixed labels instead of echoing the statement.
const REFUSED_STATEMENTS: ReadonlySet<string> = new Set([
  "ABORT",
  "ALTER",
  "ANALYZE",
  "BEGIN",
  "CALL",
  "CHECKPOINT",
  "CLOSE",
  "CLUSTER",
  "COMMENT",
  "COMMIT",
  "COPY",
  "CREATE",
  "DEALLOCATE",
  "DECLARE",
  "DELETE",
  "DISCARD",
  "DO",
  "DROP",
  "END",
  "EXECUTE",
  "FETCH",
  "GRANT",
  "IMPORT",
  "INSERT",
  "LISTEN",
  "LOAD",
  "LOCK",
  "MERGE",
  "MOVE",
  "NOTIFY",
  "PREPARE",
  "REASSIGN",
  "REFRESH",
  "REINDEX",
  "RELEASE",
  "RESET",
  "REVOKE",
  "ROLLBACK",
  "SAVEPOINT",
  "SECURITY",
  "SET",
  "START",
  "TRUNCATE",
  "UNLISTEN",
  "UPDATE",
  "VACUUM",
]);

const UNRECOGNISED_STATEMENT = "an unrecognised statement";
const UNTERMINATED_INPUT = "an unterminated comment, quote or dollar quote";

// PostgreSQL treats every code point at or above 0x80 as an identifier character.
const LEADING_WORD = /^[A-Za-z0-9_$\u{80}-\u{10FFFF}]+/u;

// The splitter reads a `BEGIN ATOMIC` body as one statement, so `WITH begin AS (SELECT 1) SELECT *
// FROM begin atomic; COMMIT; DELETE FROM t; END` hides its second and third statements from it.
const BEGIN_ATOMIC = /begin\s+atomic/iu;

const statementViolation = (statement: string): string | undefined => {
  const text = trimLeadingSqlComments(statement);
  if (text === "") return undefined;
  // Only a parenthesised SELECT or VALUES can start with `(`.
  if (text.startsWith("(")) return undefined;
  const word = LEADING_WORD.exec(text)?.[0];
  // ASCII only: `ſelect` upper-cases to `SELECT` in JS but is a plain identifier to PostgreSQL.
  const keyword = word !== undefined && /^[A-Za-z]+$/u.test(word) ? word.toUpperCase() : undefined;
  if (keyword === undefined) return UNRECOGNISED_STATEMENT;
  if (READ_STATEMENTS.has(keyword)) return undefined;
  return REFUSED_STATEMENTS.has(keyword) ? keyword : UNRECOGNISED_STATEMENT;
};

/**
 * The first reason `--read-only` refuses `sql`, as a fixed label (never the SQL): a statement
 * that does not start with one of {@link READ_ONLY_STATEMENT_KEYWORDS}, or input the splitter
 * cannot read to the end.
 */
export const findReadOnlyViolation = (sql: string): string | undefined => {
  const { statements, unterminated } = splitAndTrimChecked(sql);
  for (const statement of statements) {
    const violation = statementViolation(statement);
    if (violation !== undefined) return violation;
  }
  if (BEGIN_ATOMIC.test(sql)) return "BEGIN ATOMIC";
  return unterminated ? UNTERMINATED_INPUT : undefined;
};
