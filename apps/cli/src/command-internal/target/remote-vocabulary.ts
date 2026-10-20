export const REMOTE_FLAG_NAME = "remote";

export const DB_URL_PATTERN = /^postgres(ql)?:\/\//i;

/** The spellings of a bare `--remote`, in any case: the words the flag parser reads as true. */
export const LINKED_LITERAL = /^(true|yes|on|1|y)$/i;

export const OFF_LITERAL = /^(false|no|off|0|n)$/i;

export const isBooleanLiteral = (word: string): boolean =>
  LINKED_LITERAL.test(word) || OFF_LITERAL.test(word);

/** Whitespace or `=`: a keyword connection string or `NAME=value` pair, never a branch name. */
export const KEYWORD_DSN_PATTERN = /[\s=]/;

const NOT_A_BRANCH_NAME: ReadonlyArray<RegExp> = [
  KEYWORD_DSN_PATTERN,
  /^[a-z][a-z0-9+.-]*:\/\//i,
  /^\d+$/,
  /^[./~]/,
];

/** Whether a word reads as a branch name, not a path, URL, number, sentence or `NAME=value`. */
export const couldNameBranch = (word: string): boolean =>
  word !== "" && !NOT_A_BRANCH_NAME.some((pattern) => pattern.test(word));

/** Removes `user:pass@` from a value before it appears in an error or a warning. */
export const stripUserinfo = (value: string): string =>
  value.replace(/\/\/[^\s/]*@/g, "//").replace(/[^\s/@:]+:[^\s/]*@/g, "");
