/**
 * Whether `--<flagName>` (or `--<flagName>=`) appears in the raw argv after
 * the command path, matching cobra's `pflag.Changed` semantics — a flag
 * counts as "set" once passed explicitly, regardless of its resulting value
 * (e.g. `--use-docker=false` still counts as changed).
 */
export function hasExplicitLongFlag(
  rawArgs: ReadonlyArray<string>,
  commandPath: ReadonlyArray<string>,
  flagName: string,
): boolean {
  const commandIndex = rawArgs.findIndex((_, index) =>
    commandPath.every((segment, offset) => rawArgs[index + offset] === segment),
  );
  if (commandIndex === -1) {
    return rawArgs.some((token) => token === `--${flagName}` || token.startsWith(`--${flagName}=`));
  }

  for (let index = commandIndex + commandPath.length; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (token === undefined || token === "--") {
      return false;
    }
    if (token === `--${flagName}` || token.startsWith(`--${flagName}=`)) {
      return true;
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
