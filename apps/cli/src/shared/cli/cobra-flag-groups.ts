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
   * Canonical long names of flags whose own token was consumed as another
   * flag's value — pflag never parses them, so they stay unchanged even
   * though the token is visibly present in argv. Covers both long tokens
   * (`--type`, `--type=saml`) and mapped shorthand tokens (`-t`, `-t=saml`,
   * `-tsaml`). Used to emulate cobra's `ValidateRequiredFlags` for flags the
   * Effect parser believed were set.
   */
  readonly consumedFlagNames: ReadonlySet<string>;
  /**
   * Value-taking flags parsed BEFORE the command path completed — cobra's
   * `Find`/`stripFlags` steps over them while routing to the subcommand, but
   * pflag still parses them and marks them `Changed`, so a pre-path
   * occurrence is the effective value when every post-path token of the same
   * flag was consumed (e.g. `--profile A sso add --domains --profile`:
   * pflag keeps A). Values in argv order. Boolean pre-path flags are not
   * tracked — this exists for last-wins reconciliation of value-taking
   * persistent flags (PR #5974 review round 10).
   */
  readonly prePathOccurrences: ReadonlyMap<string, ReadonlyArray<string>>;
  /**
   * pflag's `ValueRequiredError` message when a bare value-taking flag is
   * the final argv token — byte-exact per pflag `errors.go:75,78`
   * (`flag needs an argument: --domains` / `flag needs an argument: 't' in
   * -t`). pflag fails `ParseFlags` (cobra `command.go:919`) before
   * `ValidateArgs`, every hook, `ValidateRequiredFlags`, and
   * `ValidateFlagGroups`, so handlers must reject argv carrying this before
   * any other check or side effect (binary-verified: `sso update a b
   * --domains` reports the missing argument, not the arity violation).
   */
  readonly missingValueError: string | undefined;
}

/**
 * Walks a shorthand cluster (`token.slice(1)`) the way pflag's
 * `parseShortArg`/`parseSingleShortArg` does: characters before the first
 * value-taking shorthand are boolean/unknown and consume nothing; the first
 * value-taking shorthand either carries an inline value (`-o=json`, `-ojson`)
 * or must consume the next argv token (`-o`). Returns `undefined` when no
 * character maps to a value-taking flag.
 */
function clusterValueShorthand(
  cluster: string,
  valueFlagShorthands: ReadonlyMap<string, string>,
):
  | { readonly longName: string; readonly remaining: string; readonly inlineValue?: string }
  | undefined {
  let shorthands = cluster;
  while (shorthands.length > 0) {
    const longName = valueFlagShorthands.get(shorthands[0] ?? "");
    if (longName === undefined) {
      // Boolean or unknown shorthand — consumes nothing.
      shorthands = shorthands.slice(1);
      continue;
    }
    if (shorthands.length > 2 && shorthands[1] === "=") {
      return { longName, remaining: shorthands, inlineValue: shorthands.slice(2) }; // `-o=json`
    }
    if (shorthands.length > 1) {
      return { longName, remaining: shorthands, inlineValue: shorthands.slice(1) }; // `-ojson`
    }
    return { longName, remaining: shorthands }; // `-o json`
  }
  return undefined;
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
 * - A bare `--name` not in `valueFlagNames` (a boolean flag) records pflag's
 *   bool `NoOptDefVal` `"true"` (`flag.go:1017-1019`) and consumes nothing,
 *   while an inline-empty `--name=` records `""` (`flag.go:1014-1016`) — the
 *   two must stay distinguishable because pflag hands `""` to
 *   `strconv.ParseBool`, which rejects it (PR #5974 review round 5:
 *   `--skip-url-validation=false --skip-url-validation=` aborts Go's
 *   ParseFlags; a bare repeat ends true).
 * - A shorthand cluster is walked per pflag's `parseSingleShortArg`: a
 *   value-taking shorthand takes `-t=v` / `-tv` inline or consumes the next
 *   token for `-t v`; other characters (booleans, `-h`) consume nothing.
 * - A bare `--` that was not consumed as a value terminates flag parsing;
 *   every remaining token is positional (pflag `parseArgs`).
 * - A bare value-taking flag as the very last token records nothing and
 *   reports pflag's `flag needs an argument` parse error via
 *   `missingValueError` — pflag aborts before the flag is ever Set.
 *
 * Anchoring mirrors cobra's `Find`/`stripFlags`: persistent flags (and the
 * values they consume) may sit before or between command path segments —
 * `sso --profile foo update <id>` routes to `sso update` — so the walk steps
 * over flag tokens while matching path segments in order. When the path
 * cannot be completed (a stray operand, a `--`, or argv ends), the scan
 * falls back to an unscoped pass over the whole argv.
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
  // Anchor: match the command path segments in argv order, stepping over
  // flag tokens and the values they consume (cobra `stripFlags` consumes the
  // next token for any bare value-taking flag while locating subcommands).
  let segmentIndex = 0;
  let cursor = 0;
  const prePathOccurrences = new Map<string, Array<string>>();
  const recordPrePath = (name: string, value: string) => {
    const existing = prePathOccurrences.get(name);
    if (existing === undefined) {
      prePathOccurrences.set(name, [value]);
    } else {
      existing.push(value);
    }
  };
  while (cursor < rawArgs.length && segmentIndex < commandPath.length) {
    const token = rawArgs[cursor];
    if (token === undefined || token === "--") {
      break; // `--` ends flag parsing — the path can no longer be completed.
    }
    if (token === commandPath[segmentIndex]) {
      segmentIndex += 1;
      cursor += 1;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      break; // A stray operand — this argv does not route to the command.
    }
    if (token.startsWith("--")) {
      const equalsIndex = token.indexOf("=");
      if (equalsIndex !== -1) {
        const name = token.slice(2, equalsIndex);
        if (valueFlagNames.has(name)) {
          recordPrePath(name, token.slice(equalsIndex + 1));
        }
        cursor += 1;
        continue;
      }
      const name = token.slice(2);
      if (valueFlagNames.has(name)) {
        const value = rawArgs[cursor + 1];
        if (value !== undefined) {
          recordPrePath(name, value);
        }
        cursor += 2;
        continue;
      }
      cursor += 1;
      continue;
    }
    const hit = clusterValueShorthand(token.slice(1), valueFlagShorthands);
    if (hit !== undefined) {
      if (hit.inlineValue !== undefined) {
        recordPrePath(hit.longName, hit.inlineValue);
        cursor += 1;
      } else {
        const value = rawArgs[cursor + 1];
        if (value !== undefined) {
          recordPrePath(hit.longName, value);
        }
        cursor += 2;
      }
      continue;
    }
    cursor += 1;
  }
  const anchored = segmentIndex === commandPath.length;
  const tokens = anchored ? rawArgs.slice(cursor) : rawArgs;
  // Like `positionals`, pre-path occurrences are only meaningful when the
  // scan anchored — an unscoped scan re-walks the whole argv below, so
  // keeping the partial walk's records would double-count them.
  if (!anchored) {
    prePathOccurrences.clear();
  }

  const occurrences = new Map<string, Array<string>>();
  const positionals: Array<string> = [];
  const consumedFlagNames = new Set<string>();
  let missingValueError: string | undefined;
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
  // its own. When that token is itself a flag pflag never got to parse,
  // remember its canonical name. When there is no next token, pflag fails
  // parsing (`errors.go:63-78`) — nothing is recorded because the flag never
  // gets Set. Returns the index to resume scanning from.
  const consumeNext = (name: string, index: number, missingMessage: string): number => {
    const next = tokens[index + 1];
    if (next === undefined) {
      missingValueError ??= missingMessage;
      return index;
    }
    record(name, next);
    if (next.startsWith("--") && next.length > 2) {
      const equalsIndex = next.indexOf("=");
      consumedFlagNames.add(next.slice(2, equalsIndex === -1 ? undefined : equalsIndex));
    } else if (next.startsWith("-") && !next.startsWith("--") && next !== "-") {
      // A consumed shorthand cluster (`--domains -t saml`): pflag never
      // parses `-t`, so `type` stays unchanged even though the Effect parser
      // read it as a flag (CLI-1982, PR #5974 review round 3).
      const hit = clusterValueShorthand(next.slice(1), valueFlagShorthands);
      if (hit !== undefined) {
        consumedFlagNames.add(hit.longName);
      }
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
      const hit = clusterValueShorthand(token.slice(1), valueFlagShorthands);
      if (hit !== undefined) {
        if (hit.inlineValue !== undefined) {
          record(hit.longName, hit.inlineValue); // `-o=json` / `-ojson`
        } else {
          // `-o json` — pflag `errors.go:75` quotes the shorthand character
          // and the remaining cluster when the value is missing.
          index = consumeNext(
            hit.longName,
            index,
            `flag needs an argument: '${hit.remaining[0]}' in -${hit.remaining}`,
          );
        }
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
      index = consumeNext(name, index, `flag needs an argument: --${name}`);
    } else {
      // pflag's `NoOptDefVal` branch (`flag.go:1017-1019`): a bare boolean
      // records the value pflag would Set — `"true"` — keeping it distinct
      // from the `""` an inline-empty `--name=` records above.
      record(name, "true");
    }
  }
  return {
    anchored,
    occurrences,
    positionals,
    consumedFlagNames,
    prePathOccurrences,
    missingValueError,
  };
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
