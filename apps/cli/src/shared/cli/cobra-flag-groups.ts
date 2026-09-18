/**
 * Whether `--<flagName>` (or `--<flagName>=`) appears in argv after the command path. A flag
 * counts as set once passed explicitly, regardless of its value (e.g. `--use-docker=false` still
 * counts as changed) — matching pflag's `Changed` semantics.
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

const PFLAG_BOOLEAN_FALSE_VALUES: ReadonlySet<string> = new Set([
  "0",
  "f",
  "F",
  "false",
  "FALSE",
  "False",
]);

/**
 * Last explicit `--<flagName>`/`--<flagName>=<value>` boolean occurrence in argv (`undefined` if
 * absent), matching pflag/viper's last-`Set()`-wins semantics. A bare flag is true; an inline
 * value is false only when it matches pflag's boolean false set, otherwise truthy.
 */
export function explicitBooleanLongFlag(
  rawArgs: ReadonlyArray<string>,
  flagName: string,
): boolean | undefined {
  let result: boolean | undefined;
  for (const token of rawArgs) {
    if (token === `--${flagName}`) {
      result = true;
    } else if (token.startsWith(`--${flagName}=`)) {
      result = !PFLAG_BOOLEAN_FALSE_VALUES.has(token.slice(flagName.length + 3));
    }
  }
  return result;
}

/**
 * The last explicit `--<flagName>` occurrence's value in argv (pflag's last-wins resolution:
 * `--profile a --profile b` → `b`), or `undefined` when absent. `--<flagName> <next>` consumes
 * the following token verbatim; a trailing valueless occurrence is ignored.
 */
export function lastExplicitLongFlagValue(
  rawArgs: ReadonlyArray<string>,
  commandPath: ReadonlyArray<string>,
  flagName: string,
): string | undefined {
  const commandIndex = rawArgs.findIndex((_, index) =>
    commandPath.every((segment, offset) => rawArgs[index + offset] === segment),
  );
  const start = commandIndex === -1 ? 0 : commandIndex + commandPath.length;
  let value: string | undefined;
  for (let index = start; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (token === undefined || token === "--") {
      break;
    }
    if (token === `--${flagName}`) {
      const next = rawArgs[index + 1];
      if (next !== undefined && next !== "--") {
        value = next;
        index += 1;
      }
    } else if (token.startsWith(`--${flagName}=`)) {
      value = token.slice(flagName.length + 3);
    }
  }
  return value;
}

/**
 * Value-taking long flags recognized globally — the persistent root flags (`--workdir`,
 * `--network-id`, `--profile`, `--output`, `--dns-resolver`, `--agent`) plus the TS-only
 * `--output-format` and `--log-level` — so a pflag-faithful scan doesn't miscount positionals.
 * Excludes `--completions`, which only pre-parse scanners need (see `GLOBAL_VALUE_FLAG_TOKENS`
 * below); no command handler ever runs while it's set.
 */
export const PERSISTENT_VALUE_FLAG_NAMES: ReadonlySet<string> = new Set([
  "workdir",
  "network-id",
  "profile",
  "output",
  "dns-resolver",
  "agent",
  "output-format",
  "log-level",
]);

/** Shorthands of the persistent value-taking flags above (`-o` → `--output`), mapped to their canonical long names. */
export const PERSISTENT_VALUE_FLAG_SHORTHANDS: ReadonlyMap<string, string> = new Map([
  ["o", "output"],
]);

/**
 * Token-keyed view of every value-taking global the TS parser accepts: `PERSISTENT_VALUE_FLAG_NAMES`
 * as `--` tokens, its shorthands, and `--completions` (needed only by the pre-parse scanners in
 * `run.ts` and `agent-output.ts`). Derived rather than hand-copied so the two lists cannot drift apart.
 */
export const GLOBAL_VALUE_FLAG_TOKENS: ReadonlySet<string> = new Set([
  ...[...PERSISTENT_VALUE_FLAG_NAMES].map((name) => `--${name}`),
  ...[...PERSISTENT_VALUE_FLAG_SHORTHANDS.keys()].map((short) => `-${short}`),
  "--completions",
]);

export interface PflagArgvScanSpec {
  /**
   * Every value-taking (non-boolean) long flag reachable when this command
   * parses: the command's own plus `PERSISTENT_VALUE_FLAG_NAMES`. Boolean
   * flags never consume a token and must be omitted.
   */
  readonly valueFlagNames: ReadonlySet<string>;
  /**
   * Value-taking shorthand characters (`t` for `-t`) mapped to their canonical long names.
   * Occurrences are recorded under the long name, matching pflag's behavior of reporting the
   * canonical flag regardless of which form set it.
   */
  readonly valueFlagShorthands?: ReadonlyMap<string, string>;
}

export interface PflagArgvScan {
  /** Whether the command path was found in argv and the scan is scoped to it. */
  readonly anchored: boolean;
  /**
   * Every flag pflag would mark `Changed`, mapped to the raw value of each occurrence in argv
   * order (shorthand occurrences recorded under their canonical long name).
   */
  readonly occurrences: ReadonlyMap<string, ReadonlyArray<string>>;
  /**
   * pflag-effective positional arguments: tokens not interpreted as flags and not consumed as a
   * flag's value; this can differ from what the Effect parser saw when pflag consumed a
   * flag-shaped token as a value. Only populated when `anchored`.
   */
  readonly positionals: ReadonlyArray<string>;
  /**
   * Canonical long names of flags whose own token was consumed as another flag's value — pflag
   * never parses them, so they stay unchanged even though the token is visibly present in argv
   * (covers both long and mapped shorthand spellings). Used to emulate cobra's
   * `ValidateRequiredFlags` for flags the Effect parser believed were set.
   */
  readonly consumedFlagNames: ReadonlySet<string>;
  /**
   * Value-taking flags parsed before the command path completed. Cobra routes past them while
   * locating the subcommand, but pflag still parses and marks them `Changed`, so a pre-path
   * occurrence is the effective value once every post-path token for the same flag gets consumed
   * elsewhere. Boolean pre-path flags are not tracked.
   */
  readonly prePathOccurrences: ReadonlyMap<string, ReadonlyArray<string>>;
  /**
   * pflag's `ValueRequiredError` message when a bare value-taking flag is the final argv token,
   * byte-exact (`flag needs an argument: --domains` / `flag needs an argument: 't' in -t`). pflag
   * fails parsing before any validation or side effect runs, so handlers must reject argv
   * carrying this before any other check.
   */
  readonly missingValueError: string | undefined;
}

/**
 * Walks a shorthand cluster (`token.slice(1)`) the way pflag does: characters before the first
 * value-taking shorthand are boolean/unknown and consume nothing; the first value-taking
 * shorthand either carries an inline value (`-o=json`, `-ojson`) or consumes the next argv token
 * (`-o`). Returns `undefined` when no character maps to a value-taking flag.
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
 * Scans raw argv the way pflag would after the command path completes: which flags pflag marks
 * `Changed` and their values, the resulting positional arguments, and any flag whose own token
 * was consumed as another flag's value instead of being parsed itself.
 *
 * Anchoring mirrors cobra: persistent flags may sit before or between path segments, so the walk
 * steps over flag tokens while matching the path in order, falling back to an unscoped scan when
 * the path can't be completed. The spec is per-command, and unknown flags are treated as
 * non-consuming and fail-open, since the Effect parser rejects them before any handler runs.
 */
export function pflagArgvScan(
  rawArgs: ReadonlyArray<string>,
  commandPath: ReadonlyArray<string>,
  spec: PflagArgvScanSpec,
): PflagArgvScan {
  const valueFlagNames = spec.valueFlagNames;
  const valueFlagShorthands = spec.valueFlagShorthands ?? new Map<string, string>();
  // Anchor: match command path segments in argv order, stepping over flag tokens and the values
  // they consume.
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
  // Pre-path occurrences only matter when the scan anchored; an unscoped scan re-walks argv
  // below, so keeping the partial walk's records would double-count them.
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
  // pflag consumes the next token unconditionally as the value, even if it looks like a flag —
  // remember that flag's canonical name as consumed, since pflag never parses it itself.
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
      // A consumed shorthand cluster (`--domains -t saml`): pflag never parses `-t`, so `type`
      // stays unchanged even though the Effect parser read it as a flag.
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
      // An empty token, a token without a leading dash, or a lone `-` is an operand.
      if (anchored) {
        positionals.push(token);
      }
      continue;
    }
    if (!token.startsWith("--")) {
      // Shorthand cluster: walked one character at a time; the first value-taking shorthand
      // ends the cluster.
      const hit = clusterValueShorthand(token.slice(1), valueFlagShorthands);
      if (hit !== undefined) {
        if (hit.inlineValue !== undefined) {
          record(hit.longName, hit.inlineValue); // `-o=json` / `-ojson`
        } else {
          // `-o json` — pflag quotes the shorthand character and remaining cluster when the
          // value is missing.
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
      // A bare boolean records the value pflag would set — `"true"` — keeping it distinct from
      // the `""` an inline-empty `--name=` records above.
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
 * Builds the mutually-exclusive-flag-group error message: `group` is the full set in
 * registration order (unsorted, no dashes); `changed` is the subset actually set, sorted
 * alphabetically.
 */
export function cobraMutuallyExclusiveErrorMessage(
  group: ReadonlyArray<string>,
  changed: ReadonlyArray<string>,
): string {
  const flagList = group.join(" ");
  const set = [...changed].sort().join(" ");
  return `if any flags in the group [${flagList}] are set none of the others can be; [${set}] were all set`;
}
