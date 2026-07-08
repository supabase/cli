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
 * Like `hasExplicitLongFlag`, but aware that a bare (`=`-less) occurrence of a
 * *value-taking* flag consumes the very next argv token as its value —
 * matching pflag's `parseLongArg` (`flag.go:1013-1031`), which takes the next
 * raw arg unconditionally once a long flag needs a value, with no check that
 * the token looks like another flag.
 *
 * Without this, scanning independently per flag name (as `hasExplicitLongFlag`
 * does) can mistake a consumed value for a literal occurrence of a sibling
 * mutex flag: `--metadata-file --metadata-url` is pflag's `metadata-file`
 * flag being handed the (oddly named, but valid) string value
 * `"--metadata-url"` — cobra never parses `--metadata-url` as its own flag,
 * so `metadata-url.Changed` stays `false`. A naive scan sees both tokens and
 * wrongly reports both as set.
 *
 * `valueFlagNames` must list every value-taking (non-boolean) flag declared
 * on the command being scanned, so the scan knows which bare tokens consume a
 * following value; boolean flags never consume one and must be omitted. This
 * only covers flags local to the command — a global/inherited value-taking
 * flag immediately preceding a mutex flag without `=` can still be misread
 * the same way; closing that fully would mean teaching this scan about every
 * flag reachable at parse time, not just the command's own, which is a
 * bigger, cross-cutting change.
 */
export function hasExplicitValueFlag(
  rawArgs: ReadonlyArray<string>,
  commandPath: ReadonlyArray<string>,
  valueFlagNames: ReadonlySet<string>,
  flagName: string,
): boolean {
  const commandIndex = rawArgs.findIndex((_, index) =>
    commandPath.every((segment, offset) => rawArgs[index + offset] === segment),
  );
  const scoped = commandIndex !== -1;
  const tokens = scoped ? rawArgs.slice(commandIndex + commandPath.length) : rawArgs;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || (scoped && token === "--")) {
      return false;
    }
    if (token === `--${flagName}` || token.startsWith(`--${flagName}=`)) {
      return true;
    }
    if (token.startsWith("--") && !token.includes("=") && valueFlagNames.has(token.slice(2))) {
      // Bare occurrence of a value-taking flag — skip the token it consumes
      // so it can't be mistaken for a literal occurrence of `flagName`.
      index += 1;
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
