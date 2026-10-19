export const REMOTE_FLAG_NAME = "remote";

export const DB_URL_PATTERN = /^postgres(ql)?:\/\//;

/** The spellings of a bare `--remote`, in any case. */
export const LINKED_LITERAL = /^(true|yes|on|1)$/i;

/** The spellings of an off switch, in any case. */
export const OFF_LITERAL = /^(false|no|off|0)$/i;

export const isBooleanLiteral = (word: string): boolean =>
  LINKED_LITERAL.test(word) || OFF_LITERAL.test(word);

const NOT_A_BRANCH_NAME: ReadonlyArray<RegExp> = [
  /\s/,
  /^[a-z][a-z0-9+.-]*:\/\//i,
  /^\d+$/,
  /^[./~]/,
];

/** Whether a word reads as a branch name rather than a path, URL, number or sentence. */
export const couldNameBranch = (word: string): boolean =>
  word !== "" && !NOT_A_BRANCH_NAME.some((pattern) => pattern.test(word));
