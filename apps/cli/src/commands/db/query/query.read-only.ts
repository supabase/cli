import { splitAndTrim, trimLeadingSqlComments } from "../../../command-internal/sql-split.ts";

const TRANSACTION_CONTROL = new Set(["BEGIN", "COMMIT", "END", "ABORT", "ROLLBACK"]);
const READ_ONLY_SETTINGS = new Set(["default_transaction_read_only", "transaction_read_only"]);

// A quoted identifier (optionally `U&"…"`) or an unquoted one; PostgreSQL treats every code point
// at or above 0x80 as an identifier character.
const IDENTIFIER =
  /^(?:[uU]&)?"(?:[^"]|"")*"|^[A-Za-z_\u{80}-\u{10FFFF}][A-Za-z0-9_$\u{80}-\u{10FFFF}]*/u;

interface Word {
  readonly text: string;
  readonly rest: string;
}

const nextWord = (sql: string): Word | undefined => {
  const trimmed = trimLeadingSqlComments(sql);
  const text = IDENTIFIER.exec(trimmed)?.[0];
  return text === undefined ? undefined : { text, rest: trimmed.slice(text.length) };
};

// `U&"…"` names can't be decoded cheaply, so every one counts as a possible read-only setting.
const readOnlySettingLabel = (word: Word): string | undefined => {
  if (/^u&/iu.test(word.text)) return 'U&"..."';
  const name = word.text.replace(/^"|"$/gu, "").toLowerCase();
  return READ_ONLY_SETTINGS.has(name) ? name : undefined;
};

const statementViolation = (statement: string): string | undefined => {
  const first = nextWord(statement);
  if (first === undefined) return undefined;
  const keyword = first.text.toUpperCase();
  if (TRANSACTION_CONTROL.has(keyword)) return keyword;
  if (keyword === "START" || keyword === "PREPARE") {
    return nextWord(first.rest)?.text.toUpperCase() === "TRANSACTION"
      ? `${keyword} TRANSACTION`
      : undefined;
  }
  if (keyword !== "SET" && keyword !== "RESET") return undefined;

  let subject = nextWord(first.rest);
  const scope = subject?.text.toUpperCase();
  if (subject !== undefined && keyword === "SET" && (scope === "SESSION" || scope === "LOCAL")) {
    subject = nextWord(subject.rest);
    if (scope === "SESSION" && subject?.text.toUpperCase() === "CHARACTERISTICS") {
      return "SET SESSION CHARACTERISTICS";
    }
  }
  if (subject === undefined) return undefined;
  const subjectKeyword = subject.text.toUpperCase();
  if (keyword === "SET" && subjectKeyword === "TRANSACTION") return "SET TRANSACTION";
  if (keyword === "RESET" && subjectKeyword === "ALL") return "RESET ALL";
  const setting = readOnlySettingLabel(subject);
  return setting === undefined ? undefined : `${keyword} ${setting}`;
};

/**
 * The first statement `--read-only` refuses, named by a fixed label (never the SQL): transaction
 * control, or a change to the transaction's or session's read-only characteristics.
 */
export const findReadOnlyViolation = (sql: string): string | undefined => {
  for (const statement of splitAndTrim(sql)) {
    const violation = statementViolation(statement);
    if (violation !== undefined) return violation;
  }
  return undefined;
};
