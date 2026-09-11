import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Layer, Option } from "effect";
import { GlobalFlag } from "effect/unstable/cli";
import type { Command, Param, Primitive } from "effect/unstable/cli";
import process from "node:process";
import {
  QUERY_OUTPUT_FORMATS,
  RESOURCE_OUTPUT_FORMATS,
} from "../command-internal/go-output-flag.ts";
import { unwrapParam } from "../command-internal/param-introspection.ts";
import { isValidBase0Int64, parseUintBase0 } from "../command-internal/parse-uint.ts";
import { parseStringSliceFlag } from "../command-internal/string-slice-flag.ts";
import { withAnalyticsContext } from "../shared/telemetry/analytics-context.ts";
import { Analytics } from "../shared/telemetry/analytics.service.ts";
import {
  EventCommandExecuted,
  PropDurationMs,
  PropExitCode,
  PropOutputFormat,
} from "../shared/telemetry/event-catalog.ts";
import { standaloneAnalyticsConfigLayer } from "../shared/telemetry/standalone-analytics-config.layer.ts";
import { analyticsLayer } from "../telemetry/analytics.layer.ts";
import { formatCliError, normalizeCliError } from "../shared/output/normalize-error.ts";

/**
 * Implements the shell completion protocol that cobra-generated scripts (`supabase
 * completion {bash,zsh,fish,powershell}`) call into via `supabase __complete`/
 * `__completeNoDesc` on every tab press. Completion argv can contain partial or malformed
 * flag tokens (e.g. `--de` mid-word), so this bypasses the structured CLI parser and
 * reflects directly over `rootCommand` to compute candidates.
 */

export interface CompletionCandidate {
  readonly name: string;
  readonly description: string | undefined;
}

export interface CompletionResult {
  readonly candidates: ReadonlyArray<CompletionCandidate>;
  readonly directive: number;
}

/** Bit flags for the shell completion protocol's directive value. */
export const CompletionDirective = {
  Default: 0,
  NoFileComp: 4,
  FilterFileExt: 8,
} as const;

export interface FlagDescriptor {
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly hidden: boolean;
  readonly description: string | undefined;
  readonly isVariadic: boolean;
  readonly isBoolean: boolean;
  /** `Param.Single`'s underlying `Primitive<A>._tag` (`"Boolean"`, `"Choice"`, `"Int"`, ...). */
  readonly primitiveTag: string;
  /** The valid value set for a `primitiveTag === "Choice"` flag; `undefined` for every other tag. */
  readonly choiceKeys: ReadonlyArray<string> | undefined;
}

export interface CommandPathResolution {
  readonly commandChain: ReadonlyArray<Command.Command.Any>;
  readonly matchedPath: ReadonlyArray<string>;
  readonly leftoverArgs: ReadonlyArray<string>;
}

export interface ClassifyCompletionInput {
  readonly finalCommand: Command.Command.Any;
  readonly matchedPath: ReadonlyArray<string>;
  readonly leftoverArgs: ReadonlyArray<string>;
  readonly trimmedArgs: ReadonlyArray<string>;
  readonly toComplete: string;
  readonly inScopeFlags: ReadonlyArray<FlagDescriptor>;
}

export interface CompleteDeps {
  readonly root: Command.Command.Any | undefined;
  /** The routing failure that prevented selecting a command tree, if any. */
  readonly routingFailure?: Cause.Cause<unknown>;
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdoutWrite: (message: string) => void;
  readonly stderrWrite: (message: string) => void;
  readonly exit: (code: number) => void;
  /** Fires the `cli_command_executed` telemetry capture for this request. */
  readonly captureTelemetry: (exitCode: number, durationMs: number) => Promise<void>;
}

/**
 * `config.flags`, `contextConfig.flags`, and `globalFlags` exist on `Command`
 * at runtime but aren't part of its public type. Narrow through a runtime
 * guard rather than an `as` cast, so a future `effect` upgrade that drops one
 * of these fields throws here instead of silently completing against
 * `undefined`.
 */
interface CommandInternal {
  readonly config: { readonly flags: ReadonlyArray<Param.AnyFlag> };
  readonly contextConfig: { readonly flags: ReadonlyArray<Param.AnyFlag> };
  readonly globalFlags: ReadonlyArray<GlobalFlag.GlobalFlag<any>>;
}

function hasCommandInternals(
  command: Command.Command.Any,
): command is Command.Command.Any & CommandInternal {
  return "config" in command && "contextConfig" in command && "globalFlags" in command;
}

function internalCommand(command: Command.Command.Any): CommandInternal {
  if (!hasCommandInternals(command)) {
    throw new Error(
      `complete.ts: command "${command.name}" is missing the internal config/contextConfig/globalFlags fields shell completion relies on — effect's Command implementation shape may have changed.`,
    );
  }
  return command;
}

function flattenSubcommands(command: Command.Command.Any): ReadonlyArray<Command.Command.Any> {
  return command.subcommands.flatMap((group) => group.commands);
}

/**
 * `choiceKeys` (a `Choice` primitive's valid value set) is attached via
 * `Object.assign` at runtime and isn't part of the public `Primitive<A>`
 * type, so this narrows through the same runtime-guard idiom as
 * `CommandInternal`.
 */
interface ChoicePrimitive {
  readonly choiceKeys: ReadonlyArray<string>;
}

function hasChoiceKeys(
  primitive: Primitive.Primitive<unknown>,
): primitive is Primitive.Primitive<unknown> & ChoicePrimitive {
  return "choiceKeys" in primitive;
}

function choiceKeysOf(primitive: Primitive.Primitive<unknown>): ReadonlyArray<string> | undefined {
  return hasChoiceKeys(primitive) ? primitive.choiceKeys : undefined;
}

function flagDescriptorFromParam(param: Param.AnyFlag): FlagDescriptor | undefined {
  const unwrapped = unwrapParam(param);
  if (unwrapped === undefined) return undefined;
  const { single, isVariadic } = unwrapped;
  return {
    name: single.name,
    aliases: single.aliases,
    hidden: single.hidden,
    description: Option.getOrUndefined(single.description),
    isVariadic,
    isBoolean: single.primitiveType._tag === "Boolean",
    primitiveTag: single.primitiveType._tag,
    choiceKeys: choiceKeysOf(single.primitiveType),
  };
}

/**
 * Returns in-scope flags as two alphabetically sorted blocks — inherited
 * flags, then the command's own — the order completion scripts expect. A
 * local flag shadows a same-named inherited one rather than appearing twice
 * (e.g. `db diff`'s own file-path `--output` shadows the global choice flag).
 */
export function collectInScopeFlags(
  root: Command.Command.Any,
  commandChain: ReadonlyArray<Command.Command.Any>,
): ReadonlyArray<FlagDescriptor> {
  const finalCommand = commandChain[commandChain.length - 1] ?? root;
  const ancestors = commandChain.slice(0, -1);

  const globalFlagParamsOf = (command: Command.Command.Any): ReadonlyArray<Param.AnyFlag> =>
    internalCommand(command).globalFlags.map((entry) => entry.flag);

  const inheritedParams: Array<Param.AnyFlag> = [
    ...ancestors.flatMap(globalFlagParamsOf),
    ...ancestors.flatMap((ancestor) => internalCommand(ancestor).contextConfig.flags),
  ];
  const ownParams: Array<Param.AnyFlag> = [
    ...globalFlagParamsOf(finalCommand),
    GlobalFlag.Help.flag,
    // These built-ins must resolve like any other known flag, or a typed
    // `--log-level error` poisons the rest of the completion line.
    GlobalFlag.LogLevel.flag,
    GlobalFlag.Wizard.flag,
    GlobalFlag.Completions.flag,
    // `--version` only applies to the root command; it isn't inherited by subcommands.
    ...(commandChain.length === 1 ? [GlobalFlag.Version.flag] : []),
    ...internalCommand(finalCommand).config.flags,
  ];

  const descriptorsOf = (params: ReadonlyArray<Param.AnyFlag>): ReadonlyArray<FlagDescriptor> => {
    const byName = new Map<string, FlagDescriptor>();
    for (const param of params) {
      const descriptor = flagDescriptorFromParam(param);
      if (descriptor !== undefined) byName.set(descriptor.name, descriptor);
    }
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  };

  const own = descriptorsOf(ownParams);
  const ownNames = new Set(own.map((descriptor) => descriptor.name));
  const inherited = descriptorsOf(inheritedParams).filter(
    (descriptor) => !ownNames.has(descriptor.name),
  );

  return [...inherited, ...own];
}

/**
 * Resolves a bare flag token (`--project-ref`, `-p`, or a shorthand cluster like `-po`) to
 * its owning in-scope flag, guessing which flag the current or preceding token is mid-way
 * through value-completing by treating the character immediately before the value/`=` (the
 * last character of a cluster) as the owner. This differs from `resolveShortFlagCluster`,
 * which mirrors the strict parser's first-character rule; see that function's doc comment.
 */
function resolveFlagFromToken(
  token: string,
  inScopeFlags: ReadonlyArray<FlagDescriptor>,
): FlagDescriptor | undefined {
  if (token.startsWith("--")) {
    const name = token.slice(2);
    return inScopeFlags.find((flag) => flag.name === name);
  }
  if (token.startsWith("-") && token.length > 1) {
    const shorthand = token.charAt(token.length - 1);
    return inScopeFlags.find((flag) => flag.aliases.includes(shorthand));
  }
  return undefined;
}

/**
 * Descends from `root` through `trimmedArgs`, matching each non-flag token against the
 * current command's subcommand names/aliases. A flag not yet known to be boolean is assumed
 * to consume the next token as its value, even if the flag itself isn't in scope yet. A bare
 * `--` stops the descent (end of flags); a bare `-` does not, but stays in `leftoverArgs`
 * unlike a matched command name.
 */
export function resolveCommandPath(
  root: Command.Command.Any,
  trimmedArgs: ReadonlyArray<string>,
): CommandPathResolution {
  const commandChain: Array<Command.Command.Any> = [root];
  const matchedPath: Array<string> = [];
  const consumedIndices = new Set<number>();

  let current = root;
  let index = 0;
  while (index < trimmedArgs.length) {
    const token = trimmedArgs[index];
    if (token === undefined) {
      index++;
      continue;
    }

    if (token === "--") break; // end of flags: nothing at or after this can match a subcommand.

    if (token === "-") {
      // Not flag-shaped and never a subcommand name; skip without stopping the descent, but
      // leave it in `leftoverArgs` unlike a matched command name.
      index++;
      continue;
    }

    if (token.startsWith("-")) {
      consumedIndices.add(index);
      const isLong = token.startsWith("--");
      const isSingleCharShort = !isLong && token.length === 2;
      if (!token.includes("=") && (isLong || isSingleCharShort)) {
        const inScopeSoFar = collectInScopeFlags(root, commandChain);
        const resolved = resolveFlagFromToken(token, inScopeSoFar);
        // An unrecognized flag is assumed to take a value too; only a flag already known
        // here to be boolean is exempt.
        const takesValue = resolved === undefined || !resolved.isBoolean;
        if (takesValue && index + 1 < trimmedArgs.length) {
          consumedIndices.add(index + 1);
          index += 2;
          continue;
        }
      }
      index++;
      continue;
    }

    const match = flattenSubcommands(current).find(
      (candidate) => candidate.name === token || candidate.alias === token,
    );
    if (match === undefined) break; // stop descending; this and later tokens are leftover
    current = match;
    commandChain.push(match);
    matchedPath.push(match.name);
    consumedIndices.add(index);
    index++;
  }

  const leftoverArgs = trimmedArgs.filter((_, i) => !consumedIndices.has(i));
  return { commandChain, matchedPath, leftoverArgs };
}

/**
 * File-extension filtering for a small, fixed set of file-path flags. Key =
 * `<space-joined resolved command path (excluding "supabase")>:<flag name>`.
 */
const COMPLETION_FLAG_FILE_EXTENSIONS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["sso add:metadata-file", ["xml"]],
  ["sso add:attribute-mapping-file", ["json"]],
  ["sso update:metadata-file", ["xml"]],
  ["sso update:attribute-mapping-file", ["json"]],
]);

/**
 * Flags treated as required during completion. A flag whose requirement is conditional on
 * other flags or TTY state is excluded, since completion never evaluates those conditions.
 * This is a hardcoded table rather than derived from `Flag.optional`, since some flags are
 * `Flag.optional` at parse time for validation-ordering reasons unrelated to completion. Key
 * = `<matched command path>:<flag name>`.
 */
const COMPLETION_REQUIRED_FLAGS: ReadonlySet<string> = new Set([
  "domains create:custom-hostname",
  "migration repair:status",
  "gen bearer-jwt:role",
  "sso add:type",
  "vanity-subdomains activate:desired-subdomain",
  "vanity-subdomains check-availability:desired-subdomain",
]);

function isRequiredCompletionFlag(matchedPath: ReadonlyArray<string>, flagName: string): boolean {
  return COMPLETION_REQUIRED_FLAGS.has(`${matchedPath.join(" ")}:${flagName}`);
}

/**
 * Commands whose completion always returns the `NoFileComp` directive with
 * zero candidates, since they take no positional arguments to complete. Key =
 * space-joined `matchedPath` (excluding "supabase").
 */
const COMPLETION_NO_FILE_COMP_PATHS: ReadonlySet<string> = new Set([
  "completion",
  "completion bash",
  "completion zsh",
  "completion fish",
  "completion powershell",
]);

function flagNameCandidates(
  flag: FlagDescriptor,
  toComplete: string,
): ReadonlyArray<CompletionCandidate> {
  const candidates: Array<CompletionCandidate> = [];
  const long = `--${flag.name}`;
  if (long.startsWith(toComplete)) candidates.push({ name: long, description: flag.description });
  for (const alias of flag.aliases) {
    if (alias.length !== 1) continue;
    const short = `-${alias}`;
    if (short.startsWith(toComplete))
      candidates.push({ name: short, description: flag.description });
  }
  return candidates;
}

/**
 * A lightweight, string-only approximation of "which in-scope flags have already been
 * provided", accurate for the input shapes shells actually send. Stops at a bare `--`
 * terminator; a value-taking flag consumes its following token so that value is never
 * itself mistaken for a flag; an explicit `--help=false`/`--version=false` still counts
 * as "provided", matching how "changed" flag state is tracked independent of its value.
 */
function collectChangedFlagNames(
  trimmedArgs: ReadonlyArray<string>,
  inScopeFlags: ReadonlyArray<FlagDescriptor>,
): ReadonlySet<string> {
  const changed = new Set<string>();
  let index = 0;
  while (index < trimmedArgs.length) {
    const token = trimmedArgs[index];
    index++;
    if (token === undefined) continue;
    if (token === "--") break; // end of flags: nothing at or after this is parsed as a flag.

    if (token.startsWith("--")) {
      const rest = token.slice(2);
      const equalsIndex = rest.indexOf("=");
      const name = equalsIndex === -1 ? rest : rest.slice(0, equalsIndex);
      if (name.length > 0) changed.add(name);
      if (equalsIndex === -1 && index < trimmedArgs.length) {
        const owner = inScopeFlags.find((flag) => flag.name === name);
        if (owner !== undefined && !owner.isBoolean) index++; // consumes the next token as its value.
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const consumesNextToken = markChangedShorthandCluster(token, inScopeFlags, changed);
      if (consumesNextToken && index < trimmedArgs.length) index++;
    }
  }
  return changed;
}

/**
 * Walks a short-flag cluster (e.g. `-rj`, `-o=json`), marking every shorthand up to and
 * including the value-consuming one as changed. Returns `true` when the cluster ends on a
 * non-boolean shorthand with no attached value, so the caller must skip the next token.
 */
function markChangedShorthandCluster(
  token: string,
  inScopeFlags: ReadonlyArray<FlagDescriptor>,
  changed: Set<string>,
): boolean {
  let shorthands = token.slice(1);
  while (shorthands.length > 0) {
    const owner = inScopeFlags.find((flag) => flag.aliases.includes(shorthands.charAt(0)));
    if (owner === undefined) return false; // unresolved shorthand — defensive stop, already filtered upstream.
    changed.add(owner.name);
    if (shorthands.length > 1 && shorthands.charAt(1) === "=") return false; // "-f=value": cluster ends at the explicit value.
    if (!owner.isBoolean) return shorthands.length === 1; // non-boolean: the rest of the token (if any) is its value; otherwise the next arg is.
    shorthands = shorthands.slice(1); // boolean shorthand consumed no value — keep walking the cluster.
  }
  return false;
}

/**
 * Whether `trimmedArgs` contains a genuine, unconsumed `--` terminator — one that isn't
 * itself the value a preceding value-taking flag already consumed (e.g. `--file --`). A
 * naive `trimmedArgs.includes("--")` would treat that consumed token as a terminator too,
 * wrongly shutting off flag completion for the rest of the request.
 */
function hasUnconsumedFlagTerminator(
  trimmedArgs: ReadonlyArray<string>,
  inScopeFlags: ReadonlyArray<FlagDescriptor>,
): boolean {
  let index = 0;
  while (index < trimmedArgs.length) {
    const token = trimmedArgs[index];
    index++;
    if (token === undefined) continue;
    if (token === "--") return true; // genuine, unconsumed sentinel.

    if (token.startsWith("--")) {
      const rest = token.slice(2);
      const equalsIndex = rest.indexOf("=");
      const name = equalsIndex === -1 ? rest : rest.slice(0, equalsIndex);
      if (equalsIndex === -1 && index < trimmedArgs.length) {
        const owner = inScopeFlags.find((flag) => flag.name === name);
        if (owner !== undefined && !owner.isBoolean) index++; // consumes the next token (possibly `--`) as its value.
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const cluster = resolveShortFlagCluster(token, inScopeFlags);
      const consumesNextToken =
        cluster !== undefined && !cluster.flag.isBoolean && cluster.attachedValue === undefined;
      if (consumesNextToken && index < trimmedArgs.length) index++;
    }
  }
  return false;
}

/**
 * Flags whose real validation rejects a leading `-`/`+`, unlike this tree's plain signed
 * `Flag.Int`/`Flag.String` declarations — checked before `primitiveTag` dispatch since
 * `storage cp --jobs` is declared as `Flag.String`. Key = `<matched command path>:<flag name>`.
 */
const COMPLETION_UINT_FLAGS: ReadonlySet<string> = new Set([
  "functions deploy:jobs",
  "migration down:last",
  "db reset:last",
  "storage cp:jobs",
]);

/**
 * Flags validated against Go duration syntax (see `isValidGoDuration`) rather than this
 * tree's plain `Flag.String` declarations.
 */
const COMPLETION_DURATION_FLAGS: ReadonlySet<string> = new Set([
  "gen types:query-timeout",
  "gen bearer-jwt:valid-for",
]);

/** `--exp` (`gen bearer-jwt`) is validated as an RFC 3339 timestamp, not a plain string. */
const COMPLETION_RFC3339_FLAGS: ReadonlySet<string> = new Set(["gen bearer-jwt:exp"]);

/** Nanosecond scale for each unit the Go duration grammar accepts. */
const GO_DURATION_UNIT_NANOS: ReadonlyMap<string, bigint> = new Map([
  ["ns", 1n],
  ["us", 1_000n],
  ["µs", 1_000n], // U+00B5 micro sign
  ["μs", 1_000n], // U+03BC Greek mu
  ["ms", 1_000_000n],
  ["s", 1_000_000_000n],
  ["m", 60_000_000_000n],
  ["h", 3_600_000_000_000n],
]);

// Go's duration grammar accumulates into a `uint64` (range-checked against `1<<63`
// mid-parse) and narrows to the `int64` max in the final non-negative check below.
const GO_DURATION_UINT64_OVERFLOW_BOUND = 1n << 63n;
const GO_DURATION_MAX_INT64 = (1n << 63n) - 1n;

function isAsciiDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

/**
 * Validates the Go duration syntax (`1h30m`, `1.5h`, `.5s`) these flags accept, returning a
 * boolean verdict rather than a parsed value. Uses `BigInt` for the integer/fraction
 * accumulators to match Go's `uint64` overflow semantics exactly, and a plain `Number` for
 * the one step Go performs in `float64` — a JS `number` is itself an IEEE-754 double, so
 * this round-trips bit-for-bit rather than merely approximating it.
 */
function isValidGoDuration(value: string): boolean {
  let rest = value;
  let negative = false;
  if (rest.length > 0 && (rest[0] === "-" || rest[0] === "+")) {
    negative = rest[0] === "-";
    rest = rest.slice(1);
  }
  if (rest === "0") return true;
  if (rest === "") return false;

  let total = 0n;
  while (rest.length > 0) {
    if (!(rest[0] === "." || isAsciiDigit(rest[0]))) return false;

    // Digits before the decimal point; overflow fails immediately without consuming more.
    let i = 0;
    let intPart = 0n;
    while (isAsciiDigit(rest[i])) {
      if (intPart > GO_DURATION_UINT64_OVERFLOW_BOUND / 10n) return false;
      intPart = intPart * 10n + BigInt(rest[i] as string);
      if (intPart > GO_DURATION_UINT64_OVERFLOW_BOUND) return false;
      i++;
    }
    const hasIntDigits = i > 0;
    rest = rest.slice(i);

    // Digits after `.`; overflow here stops accumulating precision but keeps consuming.
    let fracPart = 0n;
    let scale = 1n;
    let hasFracDigits = false;
    if (rest.length > 0 && rest[0] === ".") {
      rest = rest.slice(1);
      let j = 0;
      let fracOverflowed = false;
      while (isAsciiDigit(rest[j])) {
        if (!fracOverflowed) {
          if (fracPart > GO_DURATION_MAX_INT64 / 10n) {
            fracOverflowed = true;
          } else {
            const next = fracPart * 10n + BigInt(rest[j] as string);
            if (next > GO_DURATION_UINT64_OVERFLOW_BOUND) {
              fracOverflowed = true;
            } else {
              fracPart = next;
              scale *= 10n;
            }
          }
        }
        j++;
      }
      hasFracDigits = j > 0;
      rest = rest.slice(j);
    }
    if (!hasIntDigits && !hasFracDigits) return false;

    // Consume the unit: every character up to the next digit/`.`.
    let k = 0;
    while (k < rest.length && !(rest[k] === "." || isAsciiDigit(rest[k]))) k++;
    if (k === 0) return false; // missing unit
    const unitNanos = GO_DURATION_UNIT_NANOS.get(rest.slice(0, k));
    rest = rest.slice(k);
    if (unitNanos === undefined) return false; // unknown unit

    if (intPart > GO_DURATION_UINT64_OVERFLOW_BOUND / unitNanos) return false;
    let termNanos = intPart * unitNanos;
    if (fracPart > 0n) {
      const fractional = Number(fracPart) * (Number(unitNanos) / Number(scale));
      termNanos += BigInt(Math.trunc(fractional));
      if (termNanos > GO_DURATION_UINT64_OVERFLOW_BOUND) return false;
    }
    total += termNanos;
    if (total > GO_DURATION_UINT64_OVERFLOW_BOUND) return false;
  }

  // The negative side already got the larger `1<<63` bound above (int64's two's-complement
  // asymmetry); only the non-negative case needs this final check.
  return negative || total <= GO_DURATION_MAX_INT64;
}

/**
 * Matches RFC 3339 (`2006-01-02T15:04:05Z07:00`): fractional seconds may use either `.` or
 * `,`, and the offset's own hour/minute are independently capped at 24/60 (not the 0-23/0-59
 * bounds used for the time fields themselves). Calendar validity is checked by round-tripping
 * through `Date#setUTCFullYear`, which — unlike the `Date` constructor — doesn't special-case
 * a 0-99 year into 1900+year.
 */
const GO_RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.,]\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isValidGoRfc3339(value: string): boolean {
  const match = GO_RFC3339_PATTERN.exec(value);
  if (match === null) return false;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (offsetHour !== undefined && (Number(offsetHour) > 24 || Number(offsetMinute) > 60))
    return false;

  const roundTrip = new Date(0);
  roundTrip.setUTCFullYear(y, mo - 1, d);
  return (
    roundTrip.getUTCFullYear() === y &&
    roundTrip.getUTCMonth() === mo - 1 &&
    roundTrip.getUTCDate() === d
  );
}

/**
 * `db reset`'s `--sql-paths` stores each repeated occurrence verbatim, unlike every other
 * variadic string flag in this tree, which CSV-splits each occurrence. Kept as a small
 * exclusion set rather than an inclusion table, since the inclusion side is much longer.
 * Key = `<matched command path>:<flag name>`.
 */
const COMPLETION_NON_CSV_VARIADIC_FLAGS: ReadonlySet<string> = new Set(["db reset:sql-paths"]);

/**
 * Validates a CSV-per-occurrence variadic flag's value with `parseStringSliceFlag`, reused
 * directly so the two never drift.
 */
function isValidCsvFlagValue(value: string): boolean {
  try {
    parseStringSliceFlag([value]);
    return true;
  } catch {
    return false;
  }
}

/**
 * `--output` is modeled as one global flag whose `choiceKeys` is the union of two distinct
 * enums (`env|pretty|json|toml|yaml` everywhere else, `json|table|csv` for `db query`), so
 * `flag.choiceKeys` alone can't tell which applies at the resolved command. This restores
 * per-command validation.
 */
function outputFlagChoiceKeys(matchedPath: ReadonlyArray<string>): ReadonlyArray<string> {
  return matchedPath.length === 2 && matchedPath[0] === "db" && matchedPath[1] === "query"
    ? QUERY_OUTPUT_FORMATS
    : RESOURCE_OUTPUT_FORMATS;
}

/**
 * Validates a flag's value; an invalid value returns zero candidates with the Default
 * directive, exactly like an unresolved flag name. The command-dependent overrides
 * (`COMPLETION_UINT_FLAGS`, `COMPLETION_DURATION_FLAGS`, `COMPLETION_RFC3339_FLAGS`,
 * `COMPLETION_NON_CSV_VARIADIC_FLAGS`) are checked before the `primitiveTag` dispatch, since
 * they key on `matchedPath`, which a bare `FlagDescriptor` can't express.
 */
function isValidFlagValue(
  matchedPath: ReadonlyArray<string>,
  flag: FlagDescriptor,
  value: string,
): boolean {
  const key = `${matchedPath.join(" ")}:${flag.name}`;
  if (COMPLETION_UINT_FLAGS.has(key)) {
    return "value" in parseUintBase0(value);
  }
  if (COMPLETION_DURATION_FLAGS.has(key)) {
    return isValidGoDuration(value);
  }
  if (COMPLETION_RFC3339_FLAGS.has(key)) {
    return isValidGoRfc3339(value);
  }
  if (
    flag.isVariadic &&
    flag.primitiveTag === "String" &&
    !COMPLETION_NON_CSV_VARIADIC_FLAGS.has(key)
  ) {
    return isValidCsvFlagValue(value);
  }
  switch (flag.primitiveTag) {
    case "Boolean":
      return parseGoBool(value) !== undefined;
    case "Choice":
      if (flag.name === "output") {
        return outputFlagChoiceKeys(matchedPath).includes(value);
      }
      return flag.choiceKeys !== undefined && flag.choiceKeys.includes(value);
    case "Int":
      return isValidBase0Int64(value);
    case "Finite":
      return value.trim().length > 0 && !Number.isNaN(Number(value));
    default:
      return true;
  }
}

/**
 * Walks a short-flag cluster (`-o`, `-ojson`, `-rj`, `-o=json`), where the first non-boolean
 * character owns the value, not the last — unlike `resolveFlagFromToken`'s completion guess,
 * this strictly parses a complete token, so `-j4` resolves to `--jobs=4` rather than an
 * unknown flag. Returns `undefined` if any character fails to resolve; the returned
 * `attachedValue` is `undefined` only when nothing is left to attach, meaning a following
 * token supplies it instead.
 */
function resolveShortFlagCluster(
  token: string,
  inScopeFlags: ReadonlyArray<FlagDescriptor>,
): { readonly flag: FlagDescriptor; readonly attachedValue: string | undefined } | undefined {
  let shorthands = token.slice(1);
  let lastResolved: FlagDescriptor | undefined;
  while (shorthands.length > 0) {
    const owner = inScopeFlags.find((flag) => flag.aliases.includes(shorthands.charAt(0)));
    if (owner === undefined) return undefined;
    lastResolved = owner;
    if (shorthands.length > 1 && shorthands.charAt(1) === "=") {
      return { flag: owner, attachedValue: shorthands.slice(2) };
    }
    if (!owner.isBoolean) {
      return {
        flag: owner,
        attachedValue: shorthands.length > 1 ? shorthands.slice(1) : undefined,
      };
    }
    shorthands = shorthands.slice(1); // boolean shorthand consumed no value — keep walking the cluster.
  }
  return lastResolved === undefined ? undefined : { flag: lastResolved, attachedValue: undefined };
}

/**
 * Finds the first token that's flag-shaped but unresolved, resolves to a flag whose value
 * fails `isValidFlagValue`, or is a non-boolean flag with no value available (only when
 * `toComplete` is itself flag-shaped; otherwise a trailing flag is understood to be
 * mid-value-completion). A bare `--` ends the scan without counting as unresolved. This
 * check takes priority even over the `--help`/`--version` short-circuit below.
 */
function findUnresolvedFlagToken(
  trimmedArgs: ReadonlyArray<string>,
  toComplete: string,
  inScopeFlags: ReadonlyArray<FlagDescriptor>,
  matchedPath: ReadonlyArray<string>,
): string | undefined {
  // A trailing flag with no value counts as unresolved only when `toComplete` is itself
  // flag-shaped; otherwise it's understood to be mid-value-completion instead.
  const trailingMissingValueIsFatal = toComplete.startsWith("-");

  let index = 0;
  while (index < trimmedArgs.length) {
    const token = trimmedArgs[index];
    index++;
    if (token === undefined || token === "-" || !token.startsWith("-")) continue;
    if (token === "--") break;

    if (token.startsWith("--")) {
      const equalsIndex = token.indexOf("=");
      const bareToken = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
      const resolved = resolveFlagFromToken(bareToken, inScopeFlags);
      if (resolved === undefined) return token;

      if (equalsIndex !== -1) {
        if (!isValidFlagValue(matchedPath, resolved, token.slice(equalsIndex + 1))) return token;
        continue;
      }
      if (resolved.isBoolean) continue;
      if (index >= trimmedArgs.length) {
        if (trailingMissingValueIsFatal) return token;
        continue;
      }
      const value = trimmedArgs[index];
      index++; // skip the consumed value token
      if (value !== undefined && !isValidFlagValue(matchedPath, resolved, value)) return value;
      continue;
    }

    const cluster = resolveShortFlagCluster(token, inScopeFlags);
    if (cluster === undefined) return token;
    // An attached value (`-o=json`, or a non-boolean's `-ojson`) is validated before the
    // boolean short-circuit below, since a boolean shorthand can also take an explicit value.
    if (cluster.attachedValue !== undefined) {
      if (!isValidFlagValue(matchedPath, cluster.flag, cluster.attachedValue)) return token;
      continue;
    }
    if (cluster.flag.isBoolean) continue;
    if (index >= trimmedArgs.length) {
      if (trailingMissingValueIsFatal) return token;
      continue;
    }
    const value = trimmedArgs[index];
    index++; // skip the consumed value token
    if (value !== undefined && !isValidFlagValue(matchedPath, cluster.flag, value)) return value;
  }
  return undefined;
}

function flagValueCompletion(
  matchedPath: ReadonlyArray<string>,
  flagName: string | undefined,
): CompletionResult {
  const key = flagName === undefined ? undefined : `${matchedPath.join(" ")}:${flagName}`;
  const extensions = key === undefined ? undefined : COMPLETION_FLAG_FILE_EXTENSIONS.get(key);
  if (extensions !== undefined) {
    return {
      candidates: extensions.map((extension) => ({ name: extension, description: undefined })),
      directive: CompletionDirective.FilterFileExt,
    };
  }
  return { candidates: [], directive: CompletionDirective.Default };
}

/**
 * `help <args>` completes as if `<args>` were being typed directly, so `help db d` offers
 * `db`'s own subcommands (`diff`, `dump`) filtered by `d`. An unresolved leftover positional
 * returns no candidates only when nothing beyond `help` resolved at all (e.g. `help bogus`);
 * a leftover under any resolved command still lists that command's subcommands.
 */
function helpArgumentCandidates(
  root: Command.Command.Any,
  argsAfterHelp: ReadonlyArray<string>,
  toComplete: string,
): CompletionResult {
  const { matchedPath, leftoverArgs, commandChain } = resolveCommandPath(root, argsAfterHelp);
  if (matchedPath.length === 0 && leftoverArgs.length > 0) {
    return { candidates: [], directive: CompletionDirective.NoFileComp };
  }

  const resolved = commandChain[commandChain.length - 1] ?? root;
  const visibleSubcommands = flattenSubcommands(resolved).filter((sub) => !sub.unlisted);
  const candidates: Array<CompletionCandidate> = visibleSubcommands.map((sub) => ({
    name: sub.name,
    description: sub.shortDescription ?? sub.description,
  }));
  // `help` is included when nothing after it resolved, since it's one of root's own subcommands.
  if (matchedPath.length === 0) {
    candidates.push({ name: "help", description: "Help about any command" });
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name));

  return {
    candidates: candidates.filter((candidate) => candidate.name.startsWith(toComplete)),
    directive: CompletionDirective.NoFileComp,
  };
}

/**
 * Classifies a completion request into candidates + directive, in priority order: an
 * unresolved/invalid flag-shaped token or unmatched root positional short-circuits first,
 * ahead of `--help`/`--version`; an unconsumed `--` then disables flag-name/flag-value
 * completion; otherwise a bare flag with no `=` gets flag-name completion, a flag's value
 * slot gets flag-value completion, and everything else gets subcommand-name completion.
 */
export function classifyCompletion(input: ClassifyCompletionInput): CompletionResult {
  const { finalCommand, matchedPath, leftoverArgs, trimmedArgs, toComplete, inScopeFlags } = input;
  const isAtRoot = matchedPath.length === 0;

  if (findUnresolvedFlagToken(trimmedArgs, toComplete, inScopeFlags, matchedPath) !== undefined) {
    return { candidates: [], directive: CompletionDirective.Default };
  }

  // A bare `-` or empty string doesn't count as a genuine leftover positional, even though
  // `resolveCommandPath` keeps it in `leftoverArgs` for other purposes. `help` is exempted
  // since `helpArgumentCandidates` handles its own leftover-positional case separately.
  const rootLeftoverPositionals = leftoverArgs.filter((arg) => arg !== "" && !arg.startsWith("-"));
  if (isAtRoot && trimmedArgs[0] !== "help" && rootLeftoverPositionals.length > 0) {
    // Resolving to root itself with a leftover positional is treated as an unknown command; a
    // leftover positional under any other resolved command is not an error.
    return { candidates: [], directive: CompletionDirective.Default };
  }

  // `collectChangedFlagNames`, not a raw token scan, correctly treats a positional `--help`
  // past a `--` terminator, or one consumed as a preceding flag's value, as not present.
  const changedFlagNames = collectChangedFlagNames(trimmedArgs, inScopeFlags);

  // `--version` only applies at root; `--help` is available at every depth.
  if (changedFlagNames.has("help") || (isAtRoot && changedFlagNames.has("version"))) {
    return { candidates: [], directive: CompletionDirective.NoFileComp };
  }

  const requiredFlags = inScopeFlags.filter(
    (flag) => isRequiredCompletionFlag(matchedPath, flag.name) && !changedFlagNames.has(flag.name),
  );

  const toCompleteIsFlag = toComplete.startsWith("-");
  const toCompleteEqualsIndex = toComplete.indexOf("=");
  // Once a genuine `--` terminator has appeared, flag-name/flag-value completion never runs
  // again for the rest of the request.
  const hasFlagTerminator = hasUnconsumedFlagTerminator(trimmedArgs, inScopeFlags);

  // Case 1: flag-NAME completion.
  if (!hasFlagTerminator && toCompleteIsFlag && toCompleteEqualsIndex === -1) {
    const requiredCandidates = requiredFlags.flatMap((flag) =>
      flagNameCandidates(flag, toComplete),
    );
    // If any required flag is still unset, only required flags are offered.
    if (requiredCandidates.length > 0) {
      return { candidates: requiredCandidates, directive: CompletionDirective.NoFileComp };
    }
    const candidates = inScopeFlags
      .filter((flag) => !flag.hidden && (!changedFlagNames.has(flag.name) || flag.isVariadic))
      .flatMap((flag) => flagNameCandidates(flag, toComplete));
    return { candidates, directive: CompletionDirective.NoFileComp };
  }

  // Case 2: flag-VALUE completion.
  if (!hasFlagTerminator) {
    if (toCompleteIsFlag) {
      // A `--flag=value` token is always treated as flag-value completion, even for a
      // boolean flag.
      const resolved = resolveFlagFromToken(
        toComplete.slice(0, toCompleteEqualsIndex),
        inScopeFlags,
      );
      return flagValueCompletion(matchedPath, resolved?.name);
    }
    const precedingToken = trimmedArgs[trimmedArgs.length - 1];
    if (
      precedingToken !== undefined &&
      precedingToken.startsWith("-") &&
      // A bare `-` is excluded, so it falls through to Case 3 instead of hard-stopping.
      precedingToken !== "-" &&
      !precedingToken.includes("=")
    ) {
      const resolved = resolveFlagFromToken(precedingToken, inScopeFlags);
      if (resolved === undefined) {
        // An unresolved trailing flag before an empty/non-flag toComplete is a hard stop,
        // not a fall-through to noun completion.
        return { candidates: [], directive: CompletionDirective.Default };
      }
      if (!resolved.isBoolean) {
        return flagValueCompletion(matchedPath, resolved.name);
      }
      // A resolved boolean precedingToken falls through to Case 3, since it never
      // consumed a value.
    }
  }

  // Case 3: subcommand-name + required-flag (bare noun) completion.
  const candidates: Array<CompletionCandidate> = [];
  let directive: number = CompletionDirective.Default;

  // A `help ...` request is resolved separately, since `help` isn't a real command node
  // in this tree.
  if (isAtRoot && trimmedArgs[0] === "help") {
    return helpArgumentCandidates(finalCommand, trimmedArgs.slice(1), toComplete);
  }

  // Any flag or extra positional token before this position suppresses subcommand-name
  // completion entirely, leaving the directive at Default.
  if (leftoverArgs.length === 0) {
    const visibleSubcommands = flattenSubcommands(finalCommand).filter((sub) => !sub.unlisted);
    if (visibleSubcommands.length > 0) {
      directive = CompletionDirective.NoFileComp;
      const subcommandCandidates: Array<CompletionCandidate> = visibleSubcommands.map((sub) => ({
        name: sub.name,
        description: sub.shortDescription ?? sub.description,
      }));
      // `help` isn't a real command node in this tree; synthesize it as a candidate, but
      // only at root, not recursively on descendants.
      if (isAtRoot) {
        subcommandCandidates.push({ name: "help", description: "Help about any command" });
      }
      // Sorted alphabetically so the synthetic "help" entry lands in its correct position
      // at root; a no-op everywhere else, since subcommands are already declared in order.
      subcommandCandidates.sort((a, b) => a.name.localeCompare(b.name));
      for (const candidate of subcommandCandidates) {
        if (candidate.name.startsWith(toComplete)) {
          candidates.push(candidate);
        }
      }
    }
  }

  // Required flags are always offered here, regardless of `leftoverArgs`.
  for (const flag of requiredFlags) {
    candidates.push(...flagNameCandidates(flag, toComplete));
  }

  // Overrides whatever directive the subcommand walk above set; see
  // `COMPLETION_NO_FILE_COMP_PATHS`.
  if (COMPLETION_NO_FILE_COMP_PATHS.has(matchedPath.join(" "))) {
    directive = CompletionDirective.NoFileComp;
  }

  return { candidates, directive };
}

/**
 * The pure, deps-free completion algorithm: resolves the command path, collects in-scope
 * flags, and classifies the request. Returns `undefined` when `argv[0]` isn't a completion
 * request, or when there are no args to classify.
 */
export function respondToComplete(
  root: Command.Command.Any | undefined,
  argv: ReadonlyArray<string>,
): CompletionResult | undefined {
  if (argv[0] !== "__complete" && argv[0] !== "__completeNoDesc") return undefined;
  if (root === undefined) return undefined;

  const args = argv.slice(1);
  if (args.length === 0) return undefined;

  const toComplete = args[args.length - 1] ?? "";
  const trimmedArgs = args.slice(0, -1);

  const { commandChain, matchedPath, leftoverArgs } = resolveCommandPath(root, trimmedArgs);
  const finalCommand = commandChain[commandChain.length - 1] ?? root;
  const inScopeFlags = collectInScopeFlags(root, commandChain);

  return classifyCompletion({
    finalCommand,
    matchedPath,
    leftoverArgs,
    trimmedArgs,
    toComplete,
    inScopeFlags,
  });
}

const GO_TRUE_BOOL_SPELLINGS: ReadonlySet<string> = new Set([
  "1",
  "t",
  "T",
  "TRUE",
  "true",
  "True",
]);
const GO_FALSE_BOOL_SPELLINGS: ReadonlySet<string> = new Set([
  "0",
  "f",
  "F",
  "FALSE",
  "false",
  "False",
]);

function parseGoBool(value: string): boolean | undefined {
  if (GO_TRUE_BOOL_SPELLINGS.has(value)) return true;
  if (GO_FALSE_BOOL_SPELLINGS.has(value)) return false;
  return undefined;
}

/**
 * `argv[0] === "__completeNoDesc"` always wins; otherwise `SUPABASE_COMPLETION_DESCRIPTIONS`
 * is checked first, falling back to `COBRA_COMPLETION_DESCRIPTIONS` when unset or empty. An
 * unparseable value is ignored, leaving the `argv[0]`-derived default in place.
 */
export function resolveIncludeDescriptions(
  argv0: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  let includeDescriptions = argv0 !== "__completeNoDesc";
  if (includeDescriptions) {
    const raw = env.SUPABASE_COMPLETION_DESCRIPTIONS || env.COBRA_COMPLETION_DESCRIPTIONS || "";
    const parsed = parseGoBool(raw);
    if (parsed !== undefined) includeDescriptions = parsed;
  }
  return includeDescriptions;
}

function formatCompletionLine(
  candidate: CompletionCandidate,
  includeDescriptions: boolean,
): string {
  if (!includeDescriptions) return candidate.name.trim();
  const firstDescriptionLine = (candidate.description ?? "").split("\n")[0] ?? "";
  // Trimming the whole joined string, not just the description, drops the trailing tab
  // when there's no description.
  return `${candidate.name}\t${firstDescriptionLine}`.trim();
}

/**
 * Formats a completion result as the shell completion protocol expects: one line per
 * candidate (`name` or `name\tdescription`), then a final `:<directive>` line, each ending
 * with `\n`.
 */
export function formatCompletionResponse(
  response: CompletionResult,
  includeDescriptions: boolean,
): string {
  const lines = response.candidates.map((candidate) =>
    formatCompletionLine(candidate, includeDescriptions),
  );
  lines.push(`:${response.directive}`);
  return lines.map((line) => `${line}\n`).join("");
}

/**
 * Fires the `cli_command_executed` telemetry capture for a `__complete`/`__completeNoDesc`
 * request — the only thing that captures it, since no command handler runs on this path.
 * `command` is always `"__complete"` (never the alias); `output_format` is fixed to `"text"`
 * since `__complete` disables flag parsing. Intentionally skips profile/workdir/upgrade
 * bootstrapping, since none of it affects analytics and scripts discard this process's stderr.
 */
export function captureCompleteTelemetryEffect(
  exitCode: number,
  durationMs: number,
): Effect.Effect<void, never, Analytics> {
  return Effect.gen(function* () {
    const analytics = yield* Analytics;
    yield* analytics.capture(EventCommandExecuted, {
      [PropExitCode]: exitCode,
      [PropDurationMs]: durationMs,
      [PropOutputFormat]: "text",
    });
  }).pipe(
    withAnalyticsContext({
      command_run_id: crypto.randomUUID(),
      command: "__complete",
      flags: undefined,
    }),
  );
}

const COMPLETE_TELEMETRY_TIMEOUT = "2 seconds";

// `analyticsLayer` needs `CliSettings`/`RuntimeInfo`/`Tty` plus a platform layer;
// `standaloneAnalyticsConfigLayer` packages that small set for a caller outside the full
// CLI runtime tree.
const completeAnalyticsLayer = analyticsLayer.pipe(
  Layer.provide(standaloneAnalyticsConfigLayer),
  Layer.provide(BunServices.layer),
);

/**
 * Production default for `CompleteDeps.captureTelemetry`. Best-effort and bounded: a missing
 * consent, network hiccup, or DNS failure must never hang or fail a user's tab press. Callers
 * must `await` this before exiting, since `process.exit` kills the process without waiting
 * for pending async work.
 */
function captureCompleteTelemetry(exitCode: number, durationMs: number): Promise<void> {
  return Effect.runPromise(
    captureCompleteTelemetryEffect(exitCode, durationMs).pipe(
      Effect.provide(completeAnalyticsLayer),
      Effect.timeout(COMPLETE_TELEMETRY_TIMEOUT),
      Effect.ignore,
    ),
  );
}

/**
 * Runs before Effect's CLI argv parser, returning `false` immediately when `deps.argv[0]`
 * isn't a completion request, otherwise fully handling it and returning `true`. Async only
 * because it awaits `deps.captureTelemetry` before `deps.exit(...)`, so the capture actually
 * reaches PostHog before the process exits.
 */
export async function tryComplete(deps: CompleteDeps): Promise<boolean> {
  if (deps.argv[0] !== "__complete" && deps.argv[0] !== "__completeNoDesc") return false;

  const startedAt = Date.now();
  const response = respondToComplete(deps.root, deps.argv);
  if (response === undefined) {
    if (deps.routingFailure !== undefined) {
      const error = Cause.findErrorOption(deps.routingFailure);
      const message = Option.isSome(error)
        ? formatCliError(normalizeCliError(error.value))
        : Cause.pretty(deps.routingFailure);
      deps.stderrWrite(`${message}\n`);
    }
    await deps.captureTelemetry(1, Date.now() - startedAt);
    deps.exit(1);
    return true;
  }

  const includeDescriptions = resolveIncludeDescriptions(deps.argv[0], deps.env);
  deps.stdoutWrite(formatCompletionResponse(response, includeDescriptions));
  await deps.captureTelemetry(0, Date.now() - startedAt);
  deps.exit(0);
  return true;
}

export function defaultCompleteDeps(
  root?: Command.Command.Any,
  routingFailure?: Cause.Cause<unknown>,
): CompleteDeps {
  return {
    root,
    routingFailure,
    argv: process.argv.slice(2),
    env: process.env,
    stdoutWrite: (message) => {
      process.stdout.write(message);
    },
    stderrWrite: (message) => {
      process.stderr.write(message);
    },
    exit: (code) => {
      process.exit(code);
    },
    captureTelemetry: captureCompleteTelemetry,
  };
}
