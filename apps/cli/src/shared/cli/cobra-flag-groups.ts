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
 * Scans raw argv the way pflag's `parseLongArg` (`flag.go:1013-1031`) would,
 * returning every long flag pflag would mark `Changed` after the command
 * path, mapped to the raw value of each of its occurrences in argv order.
 *
 * pflag-faithful rules:
 * - `--name=value` records `value` (split on the first `=`) for any flag.
 * - A bare `--name` where `name` is a *value-taking* flag (`valueFlagNames`)
 *   unconditionally consumes the very next argv token as its value — even a
 *   flag-shaped token or `--`. pflag never checks that the consumed token
 *   "looks like a value", so `--metadata-file --metadata-url` is pflag's
 *   `metadata-file` flag being handed the (oddly named, but valid) string
 *   value `"--metadata-url"` — `metadata-url.Changed` stays `false`. The
 *   vendored Effect parser deliberately differs (`internal/parser.ts` only
 *   consumes `Value`-tagged tokens), which is why handlers must reconcile
 *   the values they act on against this scan instead of trusting the parsed
 *   options alone (CLI-1982).
 * - A bare `--name` not in `valueFlagNames` (a boolean flag) records the
 *   occurrence with an empty value and consumes nothing.
 * - A bare `--` that was not consumed as a value terminates flag parsing.
 * - A bare value-taking flag as the very last token records an empty value
 *   (pflag itself would error `flag needs an argument`; recording keeps the
 *   changed-set stable for mutex checks on argv the Effect parser accepts).
 *
 * `valueFlagNames` must list every value-taking (non-boolean) long flag the
 * command declares; boolean flags never consume a token and must be omitted.
 *
 * Known gaps, kept deliberately: shorthand tokens (`-t x`) are skipped
 * without consumption, and global/inherited value-taking flags not listed in
 * `valueFlagNames` are treated as non-consuming — a bare one immediately
 * preceding a scanned flag can still be misread. Closing those would mean
 * teaching the scan every flag reachable at parse time, not just the
 * command's own, which is a bigger, cross-cutting change.
 */
export function pflagLongFlagOccurrences(
  rawArgs: ReadonlyArray<string>,
  commandPath: ReadonlyArray<string>,
  valueFlagNames: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const commandIndex = rawArgs.findIndex((_, index) =>
    commandPath.every((segment, offset) => rawArgs[index + offset] === segment),
  );
  const scoped = commandIndex !== -1;
  const tokens = scoped ? rawArgs.slice(commandIndex + commandPath.length) : rawArgs;

  const occurrences = new Map<string, Array<string>>();
  const record = (name: string, value: string) => {
    const existing = occurrences.get(name);
    if (existing === undefined) {
      occurrences.set(name, [value]);
    } else {
      existing.push(value);
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    if (token === "--") {
      // Only terminate when anchored to the command path — an unscoped scan
      // cannot tell whether `--` belongs to this command's flags at all.
      if (scoped) {
        break;
      }
      continue;
    }
    if (!token.startsWith("--")) {
      // Positional value or shorthand — never recorded, never consuming.
      continue;
    }
    const equalsIndex = token.indexOf("=");
    if (equalsIndex !== -1) {
      record(token.slice(2, equalsIndex), token.slice(equalsIndex + 1));
      continue;
    }
    const name = token.slice(2);
    if (valueFlagNames.has(name)) {
      // Bare occurrence of a value-taking flag — the very next token is its
      // value, unconditionally, so it can't be read as a flag of its own.
      record(name, tokens[index + 1] ?? "");
      index += 1;
    } else {
      record(name, "");
    }
  }
  return occurrences;
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
