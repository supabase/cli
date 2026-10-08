const BOOL_TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);
const BOOL_FALSE = new Set(["0", "f", "F", "FALSE", "false", "False", ""]);

/** Parses a config bool string; returns `undefined` for anything outside the accepted forms. */
export function parseGoBool(value: string): boolean | undefined {
  if (BOOL_TRUE.has(value)) return true;
  if (BOOL_FALSE.has(value)) return false;
  return undefined;
}
