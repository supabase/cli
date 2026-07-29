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
 * Value-taking long flags registered persistently on the Go root command
 * (`apps/cli-go/cmd/root.go:324-333`: `--workdir`, `--network-id`,
 * `--profile`, `--output`, `--dns-resolver`, `--agent`), plus the TS-only
 * `--output-format` global (`shared/cli/global-flags.ts`) which the TS
 * parser accepts on any subcommand. pflag lets any of these consume the
 * following argv token, so a pflag-faithful scan must know them or it will
 * miscount positionals on perfectly normal invocations like
 * `sso update --workdir . <id>`. Keep in sync with `globalFlagsWithValues`
 * in `shared/cli/run.ts`.
 */
export const PERSISTENT_VALUE_FLAG_NAMES: ReadonlySet<string> = new Set([
  "workdir",
  "network-id",
  "profile",
  "output",
  "dns-resolver",
  "agent",
  "output-format",
]);

/**
 * Shorthands of the persistent value-taking flags above (`-o` → `--output`,
 * `cmd/root.go:330`), mapped to their canonical long names.
 */
export const PERSISTENT_VALUE_FLAG_SHORTHANDS: ReadonlyMap<string, string> = new Map([
  ["o", "output"],
]);

export interface PflagArgvScanSpec {
  /**
   * Every value-taking (non-boolean) long flag reachable when this command
   * parses: the command's own plus `PERSISTENT_VALUE_FLAG_NAMES`. Boolean
   * flags never consume a token and must be omitted.
   */
  readonly valueFlagNames: ReadonlySet<string>;
  /**
   * Value-taking shorthand characters (`t` for `-t`) mapped to their
   * canonical long names. Occurrences are recorded under the long name,
   * matching pflag, whose `Visit` reports the canonical flag regardless of
   * which form set it.
   */
  readonly valueFlagShorthands?: ReadonlyMap<string, string>;
}

export interface PflagArgvScan {
  /** Whether the command path was found in argv and the scan is scoped to it. */
  readonly anchored: boolean;
  /**
   * Every flag pflag would mark `Changed`, mapped to the raw value of each
   * of its occurrences in argv order (shorthand occurrences under their
   * canonical long name).
   */
  readonly occurrences: ReadonlyMap<string, ReadonlyArray<string>>;
  /**
   * pflag-effective positional arguments: tokens not interpreted as flags
   * and not consumed as a flag's value. Cobra's `ValidateArgs` (e.g.
   * `ExactArgs(1)`) counts THESE, which can differ from what the Effect
   * parser saw whenever pflag consumed a flag-shaped token as a value.
   * Only populated when `anchored` — an unscoped scan cannot tell command
   * path segments apart from operands.
   */
  readonly positionals: ReadonlyArray<string>;
  /**
   * Long flag names whose `--name`/`--name=…` token was itself consumed as
   * another flag's value — pflag never parses them, so they stay unchanged
   * even though the token is visibly present in argv. Used to emulate
   * cobra's `ValidateRequiredFlags` for flags the Effect parser believed
   * were set.
   */
  readonly consumedLongFlagNames: ReadonlySet<string>;
}

/**
 * Scans raw argv the way pflag's `parseArgs`/`parseLongArg`/
 * `parseSingleShortArg` (`flag.go:1013-1031, 1080-1094`) would, returning
 * every flag pflag would mark `Changed` after the command path, the
 * pflag-effective positional arguments, and the flags whose own tokens got
 * consumed as values.
 *
 * pflag-faithful rules:
 * - `--name=value` records `value` (split on the first `=`) for any flag.
 * - A bare `--name` where `name` is a *value-taking* flag
 *   (`spec.valueFlagNames`) unconditionally consumes the very next argv
 *   token as its value — even a flag-shaped token or `--`. pflag never
 *   checks that the consumed token "looks like a value", so
 *   `--metadata-file --metadata-url` is pflag's `metadata-file` flag being
 *   handed the (oddly named, but valid) string value `"--metadata-url"` —
 *   `metadata-url.Changed` stays `false`. The vendored Effect parser
 *   deliberately differs (`internal/parser.ts` only consumes `Value`-tagged
 *   tokens), which is why handlers must reconcile the values they act on
 *   against this scan instead of trusting the parsed options alone
 *   (CLI-1982).
 * - A bare `--name` not in `valueFlagNames` (a boolean flag) records the
 *   occurrence with an empty value and consumes nothing.
 * - A shorthand cluster is walked per pflag's `parseSingleShortArg`: a
 *   value-taking shorthand takes `-t=v` / `-tv` inline or consumes the next
 *   token for `-t v`; other characters (booleans, `-h`) consume nothing.
 * - A bare `--` that was not consumed as a value terminates flag parsing;
 *   every remaining token is positional (pflag `parseArgs`).
 * - A bare value-taking flag as the very last token records an empty value
 *   (pflag itself would error `flag needs an argument`; recording keeps the
 *   changed-set stable for mutex checks on argv the Effect parser accepts).
 *
 * Remaining gap, kept deliberately: the spec is written out per command
 * rather than derived from the command tree, and unknown flags are treated
 * as non-consuming. That is fail-open — argv carrying flags outside the
 * spec is rejected by the Effect parser before any handler runs, so the
 * scan can never invent a false positional (and with it a false arity
 * error) for an invocation that actually reaches a handler.
 */
export function pflagArgvScan(
  rawArgs: ReadonlyArray<string>,
  commandPath: ReadonlyArray<string>,
  spec: PflagArgvScanSpec,
): PflagArgvScan {
  const valueFlagNames = spec.valueFlagNames;
  const valueFlagShorthands = spec.valueFlagShorthands ?? new Map<string, string>();
  const commandIndex = rawArgs.findIndex((_, index) =>
    commandPath.every((segment, offset) => rawArgs[index + offset] === segment),
  );
  const anchored = commandIndex !== -1;
  const tokens = anchored ? rawArgs.slice(commandIndex + commandPath.length) : rawArgs;

  const occurrences = new Map<string, Array<string>>();
  const positionals: Array<string> = [];
  const consumedLongFlagNames = new Set<string>();
  const record = (name: string, value: string) => {
    const existing = occurrences.get(name);
    if (existing === undefined) {
      occurrences.set(name, [value]);
    } else {
      existing.push(value);
    }
  };
  // pflag's `--flag arg` / `-f arg` branches: the very next token is the
  // value, unconditionally, so it can't be read as a flag (or positional) of
  // its own. When that token is itself a long flag, remember the name pflag
  // never got to parse. Returns the index to resume scanning from.
  const consumeNext = (name: string, index: number): number => {
    const next = tokens[index + 1];
    record(name, next ?? "");
    if (next === undefined) {
      return index;
    }
    if (next.startsWith("--") && next.length > 2) {
      const equalsIndex = next.indexOf("=");
      consumedLongFlagNames.add(next.slice(2, equalsIndex === -1 ? undefined : equalsIndex));
    }
    return index + 1;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    if (token === "--") {
      // Only terminate when anchored to the command path — an unscoped scan
      // cannot tell whether `--` belongs to this command's flags at all.
      if (anchored) {
        positionals.push(...tokens.slice(index + 1));
        break;
      }
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      // pflag `parseArgs`: an empty token, a token without a leading dash,
      // or a lone `-` is an operand.
      if (anchored) {
        positionals.push(token);
      }
      continue;
    }
    if (!token.startsWith("--")) {
      // Shorthand cluster — pflag `parseShortArg` walks it one character at
      // a time; the first value-taking shorthand ends the cluster.
      let shorthands = token.slice(1);
      while (shorthands.length > 0) {
        const longName = valueFlagShorthands.get(shorthands[0] ?? "");
        if (longName === undefined) {
          // Boolean or unknown shorthand — consumes nothing.
          shorthands = shorthands.slice(1);
          continue;
        }
        if (shorthands.length > 2 && shorthands[1] === "=") {
          record(longName, shorthands.slice(2)); // `-o=json`
        } else if (shorthands.length > 1) {
          record(longName, shorthands.slice(1)); // `-ojson`
        } else {
          index = consumeNext(longName, index); // `-o json`
        }
        break;
      }
      continue;
    }
    const equalsIndex = token.indexOf("=");
    if (equalsIndex !== -1) {
      record(token.slice(2, equalsIndex), token.slice(equalsIndex + 1));
      continue;
    }
    const name = token.slice(2);
    if (valueFlagNames.has(name)) {
      index = consumeNext(name, index);
    } else {
      record(name, "");
    }
  }
  return { anchored, occurrences, positionals, consumedLongFlagNames };
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
