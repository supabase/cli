import { Effect } from "effect";
import { Flag, GlobalFlag } from "effect/unstable/cli";

import { CliArgs } from "../cli/cli-args.service.ts";
import { legacyViperBool, legacyViperEnvBool } from "./legacy-viper-env.ts";

// The Effect CLI hoists global flags out of the token stream before the leaf
// parse and builds ONE tree-wide registry, so a command cannot redeclare an
// `output` global to vary its allowed values (the registry throws on duplicate
// names). Go instead registers `--output` per command: resource commands accept
// `env|pretty|json|toml|yaml`, while `db query` accepts `json|table|csv`. We
// model that single global as the UNION of those value sets; each handler honors
// only the values its Go counterpart does (e.g. `db query` reads `table`/`csv`,
// resource commands ignore them and fall through to text). `table`/`csv` are
// only meaningful to `db query`.
export const LegacyOutputFlag = GlobalFlag.setting("output")({
  flag: Flag.choice("output", [
    "env",
    "pretty",
    "json",
    "toml",
    "yaml",
    "table",
    "csv",
  ] as const).pipe(
    Flag.withAlias("o"),
    Flag.withDescription("Output format of status variables."),
    Flag.optional,
  ),
});

export const LegacyProfileFlag = GlobalFlag.setting("profile")({
  flag: Flag.string("profile").pipe(
    Flag.withDescription("Use a specific profile for connecting to Supabase API."),
    Flag.withDefault("supabase"),
  ),
});

export const LegacyDebugFlag = GlobalFlag.setting("debug")({
  flag: Flag.boolean("debug").pipe(Flag.withDescription("Output debug logs to stderr.")),
});

export const LegacyWorkdirFlag = GlobalFlag.setting("workdir")({
  flag: Flag.string("workdir").pipe(
    Flag.withDescription("Path to a Supabase project directory."),
    Flag.optional,
  ),
});

export const LegacyExperimentalFlag = GlobalFlag.setting("experimental")({
  flag: Flag.boolean("experimental").pipe(Flag.withDescription("Enable experimental features.")),
});

export const LegacyNetworkIdFlag = GlobalFlag.setting("network-id")({
  flag: Flag.string("network-id").pipe(
    Flag.withDescription("Use the specified Docker network instead of a generated one."),
    Flag.optional,
  ),
});

export const LegacyYesFlag = GlobalFlag.setting("yes")({
  flag: Flag.boolean("yes").pipe(Flag.withDescription("Answer yes to all prompts.")),
});

export const LegacyDnsResolverFlag = GlobalFlag.setting("dns-resolver")({
  flag: Flag.choice("dns-resolver", ["native", "https"] as const).pipe(
    Flag.withDescription("Look up domain names using the specified resolver."),
    Flag.withDefault("native" as const),
  ),
});

export const LegacyCreateTicketFlag = GlobalFlag.setting("create-ticket")({
  flag: Flag.boolean("create-ticket").pipe(
    Flag.withDescription("Create a support ticket for any CLI error."),
  ),
});

export const LegacyAgentFlag = GlobalFlag.setting("agent")({
  flag: Flag.choice("agent", ["auto", "yes", "no"] as const).pipe(
    Flag.withDescription("Override agent detection: yes, no, or auto (default auto)."),
    Flag.withDefault("auto" as const),
  ),
});

export const LEGACY_GLOBAL_FLAGS = [
  LegacyOutputFlag,
  LegacyProfileFlag,
  LegacyDebugFlag,
  LegacyWorkdirFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyYesFlag,
  LegacyDnsResolverFlag,
  LegacyCreateTicketFlag,
  LegacyAgentFlag,
] as const;

const PFLAG_FALSE_VALUES = new Set(["0", "f", "F", "false", "FALSE", "False"]);

/**
 * True when the raw argv contains an explicit `--yes=<false>` (pflag's `ParseBool`
 * false set). Go binds `--yes` to viper, so a *set* pflag value wins over
 * `AutomaticEnv`; `LegacyYesFlag` is a plain boolean that can't distinguish an
 * explicit `--yes=false` from the omitted default, so we scan the raw argv (global
 * flags are position-independent). Only `--yes=false` needs special handling: for
 * `--yes` / `--yes=true` the flag is already `true`, so `flag || env` matches Go,
 * and for an omitted flag the env fallback matches Go. Reading the raw argv also
 * sidesteps however the CLI parser coerces `--yes=false`.
 */
const legacyYesFlagExplicitlyFalse = (args: ReadonlyArray<string>): boolean =>
  args.some(
    (arg) => arg.startsWith("--yes=") && PFLAG_FALSE_VALUES.has(arg.slice("--yes=".length)),
  );

/**
 * `--yes` resolved with Go's viper `AutomaticEnv` fallback: when the flag is not
 * passed, `SUPABASE_YES` is honored (`apps/cli-go/cmd/root.go:318-320` binds
 * every persistent flag, so `console.PromptYesNo` reading `viper.GetBool("YES")`
 * picks up the env var). An explicit `--yes` — including `--yes=false` — wins over
 * the env, matching viper's bound-pflag precedence. Prefer this over reading
 * {@link LegacyYesFlag} directly anywhere a command auto-confirms a prompt.
 */
export const legacyResolveYes = Effect.gen(function* () {
  const flag = yield* LegacyYesFlag;
  const cliArgs = yield* CliArgs;
  if (legacyYesFlagExplicitlyFalse(cliArgs.args)) {
    return false;
  }
  return flag || legacyViperEnvBool("SUPABASE_YES");
});

/**
 * `--yes` resolved with the project `.env` consulted too, for commands that load the nested
 * project env before prompting (`migration down`, `migration repair --all`). Go runs
 * `loadNestedEnv` — which `os.Setenv`s each project-.env key — inside `ParseDatabaseConfig`
 * before `PromptYesNo` reads `viper.GetBool("YES")` (`pkg/config/config.go:701`,
 * `internal/utils/console.go:71`), so a `SUPABASE_YES` set only in `supabase/.env`
 * auto-confirms. The shell env still wins over the file value. An explicit `--yes`
 * (including `--yes=false`) wins over both. `projectEnv` is the loaded map from
 * `legacyLoadProjectEnv`.
 */
export const legacyResolveYesWithProjectEnv = (projectEnv: Record<string, string>) =>
  Effect.gen(function* () {
    const flag = yield* LegacyYesFlag;
    const cliArgs = yield* CliArgs;
    if (legacyYesFlagExplicitlyFalse(cliArgs.args)) {
      return false;
    }
    return (
      flag || legacyViperEnvBool("SUPABASE_YES") || legacyViperBool(projectEnv["SUPABASE_YES"])
    );
  });

/**
 * `--experimental` resolved with Go's viper `AutomaticEnv` fallback: the gate in
 * `rootCmd.PersistentPreRunE` reads `viper.GetBool("EXPERIMENTAL")`
 * (`apps/cli-go/cmd/root.go:94`), so `SUPABASE_EXPERIMENTAL` enables experimental
 * commands just like the flag. A passed `--experimental` wins over the env.
 */
export const legacyResolveExperimental = Effect.gen(function* () {
  const flag = yield* LegacyExperimentalFlag;
  return flag || legacyViperEnvBool("SUPABASE_EXPERIMENTAL");
});
