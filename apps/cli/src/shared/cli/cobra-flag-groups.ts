/**
 * Whether a bare (no `=`) long flag token is one of `valueConsumingLongFlags`,
 * meaning pflag consumes the *next* raw-argv token as this flag's value —
 * even when that token itself looks like another flag (e.g. `--project-ref
 * --use-api` sets `project-ref` to the literal string `"--use-api"`; it does
 * NOT set `use-api`).
 */
function isBareValueConsumingLongFlag(
  token: string,
  valueConsumingLongFlags: ReadonlySet<string>,
): boolean {
  return (
    token.startsWith("--") && !token.includes("=") && valueConsumingLongFlags.has(token.slice(2))
  );
}

/**
 * Whether `--<flagName>` (or `--<flagName>=`) appears in the raw argv after
 * the command path, matching cobra's `pflag.Changed` semantics — a flag
 * counts as "set" once passed explicitly, regardless of its resulting value
 * (e.g. `--use-docker=false` still counts as changed).
 *
 * `valueConsumingLongFlags` must list every OTHER long flag registered on
 * this command that pflag treats as value-consuming (`StringVar`, `UintVar`,
 * `DurationVar`, custom `Var`, …) so the scan skips its space-separated value
 * token instead of mistaking a flag-looking value for `flagName` itself.
 * Boolean flags (`BoolVar`) are never value-consuming in pflag and must not
 * be listed. Pass an empty set only when the command truly has no other
 * value-consuming long flags.
 */
export function hasExplicitLongFlag(
  rawArgs: ReadonlyArray<string>,
  commandPath: ReadonlyArray<string>,
  flagName: string,
  valueConsumingLongFlags: ReadonlySet<string>,
): boolean {
  const isFlagToken = (token: string) =>
    token === `--${flagName}` || token.startsWith(`--${flagName}=`);

  const commandIndex = rawArgs.findIndex((_, index) =>
    commandPath.every((segment, offset) => rawArgs[index + offset] === segment),
  );

  if (commandIndex === -1) {
    let skipNext = false;
    for (const token of rawArgs) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (isFlagToken(token)) {
        return true;
      }
      if (isBareValueConsumingLongFlag(token, valueConsumingLongFlags)) {
        skipNext = true;
      }
    }
    return false;
  }

  let skipNext = false;
  for (let index = commandIndex + commandPath.length; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token === undefined || token === "--") {
      return false;
    }
    if (isFlagToken(token)) {
      return true;
    }
    if (isBareValueConsumingLongFlag(token, valueConsumingLongFlags)) {
      skipNext = true;
    }
  }
  return false;
}

/**
 * Byte-matches cobra's `validateExclusiveFlagGroups` error
 * (`flag_groups.go:204`): `group` is the full mutually-exclusive set in
 * registration order (unsorted, no dashes); `changed` is the subset that
 * were actually set, sorted alphabetically per cobra's own `sort.Strings`.
 */
export function cobraMutuallyExclusiveErrorMessage(
  group: ReadonlyArray<string>,
  changed: ReadonlyArray<string>,
): string {
  const flagList = group.join(" ");
  const set = [...changed].sort().join(" ");
  return `if any flags in the group [${flagList}] are set none of the others can be; [${set}] were all set`;
}
