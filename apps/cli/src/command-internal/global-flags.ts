import { Effect, Option } from "effect";
import { Flag, GlobalFlag } from "effect/cli";

import { CliArgs } from "../shared/cli/cli-args.service.ts";
import {
  VALUE_CONSUMING_LONG_FLAGS,
  VALUE_CONSUMING_SHORT_FLAGS,
} from "../shared/cli/value-consuming-flags.ts";
import { envValue } from "../shared/config/env-option.ts";
import {
  parseEnvBool,
  supabaseEnvBool,
  supabaseEnvBoolWithProjectFallback,
} from "./supabase-env.ts";

// `-o/--output` is tree-wide and can't vary per command, so it takes the union of every command's values and each handler honors its subset.
// Flag descriptions are user-visible in shell completion (`__complete`), so keep them accurate.
/** Every value the global `-o/--output` flag accepts; per-command `outputFormats` overrides widen against this list. */
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

/** The TS-only `--output-format` global, accepted on any subcommand. */
export const OutputFormatFlag = GlobalFlag.Setting("output-format")({
  flag: Flag.Literals("output-format", ["text", "json", "stream-json"]).pipe(
    Flag.withDescription("Output format: text (default), json, or stream-json (NDJSON)"),
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
    Flag.withDescription(
      "answer yes to all prompts; hosted changes only accept this flag or SUPABASE_YES exported in your shell, never supabase/.env or another .env file",
    ),
    Flag.withDefault(false),
  ),
});

export const DnsResolverFlag = GlobalFlag.Setting("dns-resolver")({
  flag: Flag.Literals("dns-resolver", ["native", "https"] as const).pipe(
    Flag.withDescription("lookup domain names using the specified resolver"),
    Flag.withDefault("native" as const),
  ),
});

// Kept parsed (and hidden) only so passing it fails with the removal error from
// `withCommandTelemetry` instead of an unknown-flag parse error.
export const CreateTicketFlag = GlobalFlag.Setting("create-ticket")({
  flag: Flag.Boolean("create-ticket").pipe(
    Flag.withDescription("Removed: report CLI problems with `supabase issue bug` instead."),
    Flag.withDefault(false),
    Flag.withHidden,
  ),
});

export const AgentFlag = GlobalFlag.Setting("agent")({
  flag: Flag.Literals("agent", ["auto", "yes", "no"] as const).pipe(
    Flag.withDescription("Override agent detection: yes, no, or auto (default auto)"),
    Flag.withDefault("auto" as const),
  ),
});

/**
 * Every global flag declared above. A value-taking one must also join `PERSISTENT_VALUE_FLAG_NAMES`
 * (`shared/cli/flag-groups.ts`), or its value token is silently misread as positional.
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
 * Every global flag's current value keyed by flag name, as telemetry's fallback for a flag missing from a handler's `flags`.
 * `serviceOption` gives a caller without the global-flag context an empty record, and each flag is read individually to avoid an `as` cast.
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

const FALSE_VALUES = new Set(["0", "f", "F", "false", "FALSE", "False"]);

// The false spellings of the CLI's boolean flag parser, which also reads one after a bare flag.
const BOOLEAN_FALSE_VALUES = new Set(["false", "no", "off", "0", "n"]);

/** Raw argv before the first bare `--`; everything after is an operand (`db pull -- --experimental=false`), so the scanners below must not read it. */
const argsBeforeOperandTerminator = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const terminatorIndex = args.indexOf("--");
  return terminatorIndex === -1 ? args : args.slice(0, terminatorIndex);
};

/** Drops tokens consumed as a flag's space-separated value, so `db pull --password --experimental=false` isn't read as a changed `--experimental`. */
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
 * The last `--yes`/`--yes=<bool>` in argv as a boolean, or `undefined` if there is none. The parser keeps the first of a repeat and can't tell
 * `--yes=false` from the default, so callers reread argv; a bare `--yes` reads a boolean literal that follows it, as the parser does.
 */
const yesFlagFromArgs = (args: ReadonlyArray<string>): boolean | undefined => {
  const tokens = nonValueConsumedTokens(argsBeforeOperandTerminator(args));
  let result: boolean | undefined;
  for (const [index, arg] of tokens.entries()) {
    if (arg === "--yes") {
      result = !BOOLEAN_FALSE_VALUES.has(tokens[index + 1] ?? "");
    } else if (arg.startsWith("--yes=")) {
      const value = arg.slice("--yes=".length);
      result = !(FALSE_VALUES.has(value) || BOOLEAN_FALSE_VALUES.has(value));
    }
  }
  return result;
};

/** `raw` is the `SUPABASE_YES` value the process sees, which may come from a dotenv file Bun autoloaded. */
export type YesSource = { readonly via: "flag" } | { readonly via: "env"; readonly raw: string };

/** The origin of a granted `--yes`, or `None`; the last `--yes`/`--yes=<bool>` decides, and an explicit false wins over the env. */
export const resolveYesSource = Effect.gen(function* () {
  const flag = yield* YesFlag;
  const cliArgs = yield* CliArgs;
  const explicit = yesFlagFromArgs(cliArgs.args);
  if (explicit === false) {
    return Option.none<YesSource>();
  }
  if (explicit ?? flag) return Option.some<YesSource>({ via: "flag" });
  const raw = yield* envValue("SUPABASE_YES");
  return raw !== undefined && parseEnvBool(raw)
    ? Option.some<YesSource>({ via: "env", raw })
    : Option.none<YesSource>();
});

/** `--yes` with a `SUPABASE_YES` fallback; an explicit flag (including `--yes=false`) wins over the env. Prefer it to reading {@link YesFlag} directly. */
export const resolveYes = Effect.map(resolveYesSource, Option.isSome);

/**
 * {@link resolveYes} that also consults the project `.env` (the `loadProjectEnvValues` map) for commands that load it before prompting;
 * shell env presence suppresses the file value (see {@link supabaseEnvBoolWithProjectFallback}), and an explicit `--yes` wins over both.
 */
export const resolveYesWithProjectEnv = (projectEnv: Record<string, string>) =>
  Effect.gen(function* () {
    const flag = yield* YesFlag;
    const cliArgs = yield* CliArgs;
    const explicit = yesFlagFromArgs(cliArgs.args);
    if (explicit !== undefined) {
      return explicit;
    }
    return flag || (yield* supabaseEnvBoolWithProjectFallback("SUPABASE_YES", projectEnv));
  });

/** The last `--experimental`/`--experimental=<bool>` in argv as a boolean, or `undefined`; the parser keeps the first of a repeat, so callers reread argv. */
const experimentalFlagFromArgs = (args: ReadonlyArray<string>): boolean | undefined => {
  let result: boolean | undefined;
  for (const arg of nonValueConsumedTokens(argsBeforeOperandTerminator(args))) {
    if (arg === "--experimental") {
      result = true;
    } else if (arg.startsWith("--experimental=")) {
      result = !FALSE_VALUES.has(arg.slice("--experimental=".length));
    }
  }
  return result;
};

/** `--experimental` with a `SUPABASE_EXPERIMENTAL` fallback; an explicit flag (including `--experimental=false`) wins over the env. */
export const resolveExperimental = Effect.gen(function* () {
  const flag = yield* ExperimentalFlag;
  const cliArgs = yield* CliArgs;
  const explicit = experimentalFlagFromArgs(cliArgs.args);
  if (explicit !== undefined) {
    return explicit;
  }
  return flag || (yield* supabaseEnvBool("SUPABASE_EXPERIMENTAL"));
});

/** {@link resolveExperimental} with the project `.env` fallback; shell env presence wins over the file and an explicit flag over both. */
export const resolveExperimentalWithProjectEnv = (projectEnv: Record<string, string>) =>
  Effect.gen(function* () {
    const flag = yield* ExperimentalFlag;
    const cliArgs = yield* CliArgs;
    const explicit = experimentalFlagFromArgs(cliArgs.args);
    if (explicit !== undefined) {
      return explicit;
    }
    return flag || (yield* supabaseEnvBoolWithProjectFallback("SUPABASE_EXPERIMENTAL", projectEnv));
  });

/** True when the last `--debug`/`--debug=<value>` in argv resolves to false, since a trailing bare `--debug` must beat an earlier `--debug=false`. */
const debugFlagExplicitlyFalse = (args: ReadonlyArray<string>): boolean => {
  let lastExplicitlyFalse = false;
  for (const arg of nonValueConsumedTokens(argsBeforeOperandTerminator(args))) {
    if (arg === "--debug") {
      lastExplicitlyFalse = false;
    } else if (arg.startsWith("--debug=")) {
      lastExplicitlyFalse = FALSE_VALUES.has(arg.slice("--debug=".length));
    }
  }
  return lastExplicitlyFalse;
};

/** `--debug` with env and project `.env` fallbacks, for debug-gated code downstream of a command that already loaded the project env; same shape as {@link resolveYesWithProjectEnv}. */
export const resolveDebugWithProjectEnv = (projectEnv: Record<string, string>) =>
  Effect.gen(function* () {
    const flag = yield* DebugFlag;
    const cliArgs = yield* CliArgs;
    if (debugFlagExplicitlyFalse(cliArgs.args)) {
      return false;
    }
    return flag || (yield* supabaseEnvBoolWithProjectFallback("SUPABASE_DEBUG", projectEnv));
  });
