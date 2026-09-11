import { Effect, Option } from "effect";
import { Flag, GlobalFlag } from "effect/unstable/cli";

import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { VALUE_CONSUMING_LONG_FLAGS, VALUE_CONSUMING_SHORT_FLAGS } from "./db-target-flags.ts";
import { viperEnvBool, viperEnvBoolWithProjectFallback } from "./viper-env.ts";

// The CLI's global-flag registry is tree-wide, so `-o/--output` can't be redeclared per command to
// vary its allowed values; this models it as the union of every command's accepted values, and
// each handler honors only the subset it cares about (e.g. `db query` reads `table`/`csv`; other
// commands ignore them and fall through to text).
//
// These flag description strings are user-visible in shell completion (`__complete` candidate
// descriptions), so keep them accurate when changing a flag.
/**
 * Every value the global `-o/--output` flag accepts. Per-command `outputFormats` overrides (e.g.
 * `config diff`'s handler-level rejection) widen against this list, so a value added here flows to
 * those commands and their tests automatically.
 */
export const GLOBAL_OUTPUT_FORMATS = [
  "env",
  "pretty",
  "json",
  "toml",
  "yaml",
  "table",
  "csv",
] as const;

export const OutputFlag = GlobalFlag.Setting("output")({
  flag: Flag.Literals("output", GLOBAL_OUTPUT_FORMATS).pipe(
    Flag.withAlias("o"),
    Flag.withDescription("output format of status variables"),
    Flag.optional,
  ),
});

export const ProfileFlag = GlobalFlag.Setting("profile")({
  flag: Flag.String("profile").pipe(
    Flag.withDescription("use a specific profile for connecting to Supabase API"),
    Flag.withDefault("supabase"),
  ),
});

export const DebugFlag = GlobalFlag.Setting("debug")({
  flag: Flag.Boolean("debug").pipe(
    Flag.withDescription("output debug logs to stderr"),
    Flag.withDefault(false),
  ),
});

export const WorkdirFlag = GlobalFlag.Setting("workdir")({
  flag: Flag.String("workdir").pipe(
    Flag.withDescription(
      "path to the directory containing your supabase/ folder; used exactly as given, with no ancestor directory search (defaults to searching upward from the current directory)",
    ),
    Flag.optional,
  ),
});

export const ExperimentalFlag = GlobalFlag.Setting("experimental")({
  flag: Flag.Boolean("experimental").pipe(
    Flag.withDescription("enable experimental features"),
    Flag.withDefault(false),
  ),
});

export const NetworkIdFlag = GlobalFlag.Setting("network-id")({
  flag: Flag.String("network-id").pipe(
    Flag.withDescription("use the specified docker network instead of a generated one"),
    Flag.optional,
  ),
});

export const YesFlag = GlobalFlag.Setting("yes")({
  flag: Flag.Boolean("yes").pipe(
    Flag.withDescription("answer yes to all prompts"),
    Flag.withDefault(false),
  ),
});

export const DnsResolverFlag = GlobalFlag.Setting("dns-resolver")({
  flag: Flag.Literals("dns-resolver", ["native", "https"] as const).pipe(
    Flag.withDescription("lookup domain names using the specified resolver"),
    Flag.withDefault("native" as const),
  ),
});

export const CreateTicketFlag = GlobalFlag.Setting("create-ticket")({
  flag: Flag.Boolean("create-ticket").pipe(
    Flag.withDescription("create a support ticket for any CLI error"),
    Flag.withDefault(false),
  ),
});

export const AgentFlag = GlobalFlag.Setting("agent")({
  flag: Flag.Literals("agent", ["auto", "yes", "no"] as const).pipe(
    Flag.withDescription("Override agent detection: yes, no, or auto (default auto)"),
    Flag.withDefault("auto" as const),
  ),
});

/**
 * Every global/persistent flag declared above.
 *
 * A value-taking flag added here must also be added to `PERSISTENT_VALUE_FLAG_NAMES`
 * (`shared/cli/cobra-flag-groups.ts`), which the handler-side pflag scans and pre-parse token
 * scanners both derive their token set from. A flag missed there fails silently: an unregistered
 * value flag won't consume its following token, so that token gets misread as positional.
 */
export const GLOBAL_FLAGS = [
  OutputFlag,
  ProfileFlag,
  DebugFlag,
  WorkdirFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  YesFlag,
  DnsResolverFlag,
  CreateTicketFlag,
  AgentFlag,
] as const;

/**
 * Resolves the current value of every global/persistent flag above, keyed by its own CLI flag
 * name. Used by `telemetry/command-telemetry.ts` as a fallback for a global flag not present in a
 * handler's own `flags` record.
 *
 * Reads via `Effect.serviceOption` so a caller without the global-flag context (e.g. a focused
 * unit test) gets an empty record instead of a missing-service defect. Reads each flag
 * individually, since each `Setting<Id, A>`'s distinct value type can't be looped over without an
 * `as` cast; `global-flags.unit.test.ts` keeps the resolved id set in sync with `GLOBAL_FLAGS`.
 */
export const globalFlagValues = Effect.gen(function* () {
  const values: Record<string, unknown> = {};
  const setIfPresent = (id: string, option: Option.Option<unknown>) => {
    if (Option.isSome(option)) values[id] = option.value;
  };
  setIfPresent(AgentFlag.id, yield* Effect.serviceOption(AgentFlag));
  setIfPresent(CreateTicketFlag.id, yield* Effect.serviceOption(CreateTicketFlag));
  setIfPresent(DebugFlag.id, yield* Effect.serviceOption(DebugFlag));
  setIfPresent(DnsResolverFlag.id, yield* Effect.serviceOption(DnsResolverFlag));
  setIfPresent(ExperimentalFlag.id, yield* Effect.serviceOption(ExperimentalFlag));
  setIfPresent(NetworkIdFlag.id, yield* Effect.serviceOption(NetworkIdFlag));
  setIfPresent(OutputFlag.id, yield* Effect.serviceOption(OutputFlag));
  setIfPresent(ProfileFlag.id, yield* Effect.serviceOption(ProfileFlag));
  setIfPresent(WorkdirFlag.id, yield* Effect.serviceOption(WorkdirFlag));
  setIfPresent(YesFlag.id, yield* Effect.serviceOption(YesFlag));
  return values;
});

const PFLAG_FALSE_VALUES = new Set(["0", "f", "F", "false", "FALSE", "False"]);

/**
 * Raw argv truncated at the first bare `--` operand terminator. This CLI's own lexer stops parsing
 * flags there too, so everything after is a positional operand, e.g. a migration name literally
 * called `--experimental=false` passed as `db pull -- --experimental=false`. The argv-scanning
 * `*ExplicitlyFalse` heuristics below must only look at this region, or a positional operand that
 * merely looks like a flag gets mistaken for an explicit one.
 */
const argsBeforeOperandTerminator = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const terminatorIndex = args.indexOf("--");
  return terminatorIndex === -1 ? args : args.slice(0, terminatorIndex);
};

/**
 * Drops tokens that pflag would consume as a value-consuming flag's value in space-separated form
 * (`--flag value` / `-f value`), so the `--yes`/`--experimental`/`--debug` argv scanners below
 * don't mistake a consumed value token for an explicit occurrence of the global flag — e.g.
 * `db pull --password --experimental=false` treats `--experimental=false` as `--password`'s
 * value, not a changed `--experimental`.
 */
const nonValueConsumedTokens = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const kept: Array<string> = [];
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    kept.push(arg);
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      const name = eqIdx === -1 ? arg.slice(2) : arg.slice(2, eqIdx);
      if (eqIdx === -1 && VALUE_CONSUMING_LONG_FLAGS.has(name)) skipNext = true;
    } else if (arg.startsWith("-") && arg.length === 2 && arg.charAt(1) !== "-") {
      if (VALUE_CONSUMING_SHORT_FLAGS.has(arg.charAt(1))) skipNext = true;
    }
  }
  return kept;
};

/**
 * True when the raw argv contains an explicit `--yes=<false>`. A plain boolean flag can't
 * distinguish an explicit `--yes=false` from the omitted default, so this scans the raw argv up to
 * the first `--` operand terminator (see {@link argsBeforeOperandTerminator}), skipping tokens
 * consumed as another flag's value (see {@link nonValueConsumedTokens}).
 */
const yesFlagExplicitlyFalse = (args: ReadonlyArray<string>): boolean =>
  nonValueConsumedTokens(argsBeforeOperandTerminator(args)).some(
    (arg) => arg.startsWith("--yes=") && PFLAG_FALSE_VALUES.has(arg.slice("--yes=".length)),
  );

/**
 * `--yes` resolved with an env fallback: when the flag isn't passed, `SUPABASE_YES` is honored. An
 * explicit `--yes` (including `--yes=false`) wins over the env. Prefer this over reading
 * {@link YesFlag} directly anywhere a command auto-confirms a prompt.
 */
export const resolveYes = Effect.gen(function* () {
  const flag = yield* YesFlag;
  const cliArgs = yield* CliArgs;
  if (yesFlagExplicitlyFalse(cliArgs.args)) {
    return false;
  }
  return flag || viperEnvBool("SUPABASE_YES");
});

/**
 * `--yes` resolved with the project `.env` consulted too, for commands that load the nested
 * project env before prompting (`migration down`, `migration repair --all`). Shell env
 * *presence* (any value) suppresses the file value entirely (see
 * {@link viperEnvBoolWithProjectFallback}); an explicit `--yes` wins over both. `projectEnv` is
 * the loaded map from `loadProjectEnv`.
 */
export const resolveYesWithProjectEnv = (projectEnv: Record<string, string>) =>
  Effect.gen(function* () {
    const flag = yield* YesFlag;
    const cliArgs = yield* CliArgs;
    if (yesFlagExplicitlyFalse(cliArgs.args)) {
      return false;
    }
    return flag || viperEnvBoolWithProjectFallback("SUPABASE_YES", projectEnv);
  });

/**
 * Resolves the raw argv's *last* explicit `--experimental` occurrence to a boolean, or `undefined`
 * if it never appears before the first `--` operand terminator. Repeated occurrences resolve to
 * the last one, the opposite of how this CLI's own flag parser resolves a repeat (first wins), so
 * a caller must reread raw argv rather than trust the parsed flag. Tokens consumed as another
 * flag's value are skipped (see {@link nonValueConsumedTokens}).
 */
const experimentalFlagFromArgs = (args: ReadonlyArray<string>): boolean | undefined => {
  let result: boolean | undefined;
  for (const arg of nonValueConsumedTokens(argsBeforeOperandTerminator(args))) {
    if (arg === "--experimental") {
      result = true;
    } else if (arg.startsWith("--experimental=")) {
      result = !PFLAG_FALSE_VALUES.has(arg.slice("--experimental=".length));
    }
  }
  return result;
};

/**
 * `--experimental` resolved with an env fallback: `SUPABASE_EXPERIMENTAL` enables experimental
 * commands when the flag isn't passed. An explicit `--experimental` (including
 * `--experimental=false`, and the last of a repeated flag) wins over the env.
 */
export const resolveExperimental = Effect.gen(function* () {
  const flag = yield* ExperimentalFlag;
  const cliArgs = yield* CliArgs;
  const explicit = experimentalFlagFromArgs(cliArgs.args);
  if (explicit !== undefined) {
    return explicit;
  }
  return flag || viperEnvBool("SUPABASE_EXPERIMENTAL");
});

/**
 * `--experimental` resolved with the project `.env` consulted too, for commands that load the
 * nested project env before branching on the experimental gate (`db reset`,
 * `db schema declarative generate`/`sync`). Shell env *presence* suppresses the file value
 * entirely (see {@link viperEnvBoolWithProjectFallback}); an explicit `--experimental` wins over
 * both. `projectEnv` is the loaded map from `loadProjectEnv`.
 */
export const resolveExperimentalWithProjectEnv = (projectEnv: Record<string, string>) =>
  Effect.gen(function* () {
    const flag = yield* ExperimentalFlag;
    const cliArgs = yield* CliArgs;
    const explicit = experimentalFlagFromArgs(cliArgs.args);
    if (explicit !== undefined) {
      return explicit;
    }
    return flag || viperEnvBoolWithProjectFallback("SUPABASE_EXPERIMENTAL", projectEnv);
  });

/**
 * True when the LAST `--debug`/`--debug=<value>` occurrence in argv resolves to false. Tracks the
 * last occurrence (unlike {@link yesFlagExplicitlyFalse}'s "any occurrence" check), since a
 * trailing bare `--debug` after an earlier `--debug=false` must win. Scans only the flag-parsing
 * region (see {@link argsBeforeOperandTerminator}) and skips tokens consumed as another flag's
 * value (see {@link nonValueConsumedTokens}).
 */
const debugFlagExplicitlyFalse = (args: ReadonlyArray<string>): boolean => {
  let lastExplicitlyFalse = false;
  for (const arg of nonValueConsumedTokens(argsBeforeOperandTerminator(args))) {
    if (arg === "--debug") {
      lastExplicitlyFalse = false;
    } else if (arg.startsWith("--debug=")) {
      lastExplicitlyFalse = PFLAG_FALSE_VALUES.has(arg.slice("--debug=".length));
    }
  }
  return lastExplicitlyFalse;
};

/**
 * `--debug` resolved with an env fallback, and the project `.env` consulted too, for debug-gated
 * behavior downstream of a command that already loaded the nested project env. `loadProjectEnv`
 * is pure, so callers pass the loaded map through explicitly — same shape as
 * {@link resolveYesWithProjectEnv}. Shell env *presence* suppresses the file value; an explicit
 * `--debug` wins over both.
 */
export const resolveDebugWithProjectEnv = (projectEnv: Record<string, string>) =>
  Effect.gen(function* () {
    const flag = yield* DebugFlag;
    const cliArgs = yield* CliArgs;
    if (debugFlagExplicitlyFalse(cliArgs.args)) {
      return false;
    }
    return flag || viperEnvBoolWithProjectFallback("SUPABASE_DEBUG", projectEnv);
  });
