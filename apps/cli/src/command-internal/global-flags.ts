import { Effect, Option } from "effect";
import { Flag, GlobalFlag } from "effect/unstable/cli";

import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { VALUE_CONSUMING_LONG_FLAGS, VALUE_CONSUMING_SHORT_FLAGS } from "./db-target-flags.ts";
import { viperEnvBool, viperEnvBoolWithProjectFallback } from "./viper-env.ts";

// The Effect CLI hoists global flags out of the token stream before the leaf
// parse and builds ONE tree-wide registry, so a command cannot redeclare an
// `output` global to vary its allowed values (the registry throws on duplicate
// names). Go instead registers `--output` per command: resource commands accept
// `env|pretty|json|toml|yaml`, while `db query` accepts `json|table|csv`. We
// model that single global as the UNION of those value sets; each handler honors
// only the values its Go counterpart does (e.g. `db query` reads `table`/`csv`,
// resource commands ignore them and fall through to text). `table`/`csv` are
// only meaningful to `db query`.
//
// Every description string below is copied VERBATIM (including Go's own
// lowercase, no-trailing-period house style for root persistent flags) from
// `apps/cli-go/cmd/root.go:337-348` — this text is directly user-visible now
// that native shell completion (CLI-1965) surfaces it in `__complete`
// candidate descriptions, where a prior Go-binary passthrough used to emit
// Go's own text byte-for-byte; before that, this only reached the TS-native
// `--help` renderer, whose overall layout already diverges from cobra's, so
// the mismatch was harder to notice (CLI-1965 review finding).
/**
 * Every value the global `-o/--output` flag accepts — the single source of
 * truth for per-command `outputFormats` overrides that widen the wrapper's
 * enum check to "all values" (e.g. `config diff`'s handler-level rejection),
 * so a value added here automatically flows to those commands and their tests.
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

export const OutputFlag = GlobalFlag.setting("output")({
  flag: Flag.choice("output", GLOBAL_OUTPUT_FORMATS).pipe(
    Flag.withAlias("o"),
    Flag.withDescription("output format of status variables"),
    Flag.optional,
  ),
});

export const ProfileFlag = GlobalFlag.setting("profile")({
  flag: Flag.string("profile").pipe(
    Flag.withDescription("use a specific profile for connecting to Supabase API"),
    Flag.withDefault("supabase"),
  ),
});

export const DebugFlag = GlobalFlag.setting("debug")({
  flag: Flag.boolean("debug").pipe(
    Flag.withDescription("output debug logs to stderr"),
    Flag.withDefault(false),
  ),
});

export const WorkdirFlag = GlobalFlag.setting("workdir")({
  flag: Flag.string("workdir").pipe(
    Flag.withDescription(
      "path to the directory containing your supabase/ folder; used exactly as given, with no ancestor directory search (defaults to searching upward from the current directory)",
    ),
    Flag.optional,
  ),
});

export const ExperimentalFlag = GlobalFlag.setting("experimental")({
  flag: Flag.boolean("experimental").pipe(
    Flag.withDescription("enable experimental features"),
    Flag.withDefault(false),
  ),
});

export const NetworkIdFlag = GlobalFlag.setting("network-id")({
  flag: Flag.string("network-id").pipe(
    Flag.withDescription("use the specified docker network instead of a generated one"),
    Flag.optional,
  ),
});

export const YesFlag = GlobalFlag.setting("yes")({
  flag: Flag.boolean("yes").pipe(
    Flag.withDescription("answer yes to all prompts"),
    Flag.withDefault(false),
  ),
});

export const DnsResolverFlag = GlobalFlag.setting("dns-resolver")({
  flag: Flag.choice("dns-resolver", ["native", "https"] as const).pipe(
    Flag.withDescription("lookup domain names using the specified resolver"),
    Flag.withDefault("native" as const),
  ),
});

export const CreateTicketFlag = GlobalFlag.setting("create-ticket")({
  flag: Flag.boolean("create-ticket").pipe(
    Flag.withDescription("create a support ticket for any CLI error"),
    Flag.withDefault(false),
  ),
});

export const AgentFlag = GlobalFlag.setting("agent")({
  flag: Flag.choice("agent", ["auto", "yes", "no"] as const).pipe(
    Flag.withDescription("Override agent detection: yes, no, or auto (default auto)"),
    Flag.withDefault("auto" as const),
  ),
});

/**
 * Every global/persistent flag declared above, mirroring the set Go registers on
 * the root command (`apps/cli-go/cmd/root.go:337-348`).
 *
 * Adding a VALUE-taking flag here also means adding its name to
 * `PERSISTENT_VALUE_FLAG_NAMES` (`shared/cli/cobra-flag-groups.ts`): the
 * handler-side pflag scans read it directly, and the pre-parse scanners
 * (`globalFlagsWithValues` in `shared/cli/run.ts`, the `agent-output.ts`
 * predicates) derive their token set from it (`GLOBAL_VALUE_FLAG_TOKENS`),
 * so that one edit covers them all. The same obligation covers the CLI
 * library's own value-taking built-ins (`--log-level` — issue #6482;
 * `--completions` is scoped per `PERSISTENT_VALUE_FLAG_NAMES`'s doc). The
 * pre-parse scanners must run even for `--help`/`--version`/bare-group
 * invocations, which cobra serves before `PersistentPreRunE` and so never
 * expose parsed flag values to read instead. A flag missed in the shared
 * registry still fails silently rather than loudly: an unregistered value
 * flag does not consume its following token, so `supabase --new-flag
 * --workdir other <cmd>` makes the upgrade notice read/write
 * `other/supabase/.temp/cli-latest`, where Go — which lets `--new-flag` eat
 * `--workdir` — resolves against the cwd. Only the bare space-separated
 * spelling diverges (`--new-flag=x --workdir other` agrees), which is what
 * makes it easy to miss.
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
 * Resolves the current value of every global/persistent flag above, keyed by
 * its own CLI flag name (each flag's `.id`, e.g. `debug`, `workdir`). Used by
 * `telemetry/command-telemetry.ts` to mirror Go's
 * `changedFlags()` walking `cmd.Parent()`'s `PersistentFlags()` in addition to
 * a command's own flags (`cmd/root_analytics.go:53-76`) — global flags here
 * live in a single Effect-context-wide registry rather than per-ancestor
 * `pflag.FlagSet`s, so this reads all of them unconditionally instead of
 * walking a parent chain (CLI-1896).
 *
 * Read via `Effect.serviceOption` (adds no `R` requirement) so a caller that
 * hasn't wired the global-flag context — e.g. a focused unit test — simply
 * gets an empty record instead of a missing-service defect; production always
 * provides every global flag through `Command.withGlobalFlags` at the CLI
 * root (`cli/root.ts`).
 *
 * Reads each flag individually (rather than looping `GLOBAL_FLAGS`)
 * because each `Setting<Id, A>` has a distinct value type `A` — a homogeneous
 * loop widens the union in a way `Effect.serviceOption` can't resolve back to
 * a single service lookup without an `as` cast, which this codebase forbids.
 * `global-flags.unit.test.ts` asserts the resolved id set stays exactly in
 * sync with `GLOBAL_FLAGS` — extend both together when adding a new
 * global flag.
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
 * Raw argv truncated at the first bare `--` operand terminator. Both pflag/cobra
 * (verified against the pinned `apps/cli-go` versions: a value placed after `--`
 * never sets `cmd.Flags().Changed(...)`) and this CLI's own lexer
 * (`effect/unstable/cli/internal/lexer.ts`, which splits on `argv.indexOf("--")`
 * into parsed tokens vs. `trailingOperands`) stop parsing flags at the first `--`
 * — everything after is a positional operand, e.g. a migration name literally
 * called `--experimental=false` passed as `db pull -- --experimental=false`. The
 * argv-scanning `*ExplicitlyFalse` heuristics below must only look at the
 * flag-parsing region, or a positional operand that merely looks like a flag gets
 * mistaken for an explicit one.
 */
const argsBeforeOperandTerminator = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const terminatorIndex = args.indexOf("--");
  return terminatorIndex === -1 ? args : args.slice(0, terminatorIndex);
};

/**
 * Drops tokens that pflag would consume as a value-consuming flag's value in
 * space-separated form (`--flag value` / `-f value`), so the `--yes`/`--experimental`
 * argv scanners below don't mistake a consumed value token for an explicit
 * occurrence of the global flag. `--yes`/`--experimental` are global,
 * position-independent flags (bound anywhere in argv), so any LOCAL command's
 * bare value-consuming flag immediately before one of them "eats" it under real
 * pflag semantics — e.g. `db pull --password --experimental=false` parses as
 * `--password`'s value being the literal string `"--experimental=false"`, not a
 * changed `--experimental` (verified against the review finding on CLI-1957: the
 * repository's own argv scanner already documents and handles this exact case for
 * `resolveDbTargetFlags`/`changedLinkedLocalFlags`
 * (`command-internal/db-target-flags.ts`) and `extractChangedFlagNames`
 * (`telemetry/command-telemetry.ts`), which this reuses the
 * same `VALUE_CONSUMING_LONG_FLAGS`/`VALUE_CONSUMING_SHORT_FLAGS` registries for,
 * so the three scans can't drift out of sync).
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
 * True when the raw argv contains an explicit `--yes=<false>` (pflag's `ParseBool`
 * false set). Go binds `--yes` to viper, so a *set* pflag value wins over
 * `AutomaticEnv`; `YesFlag` is a plain boolean that can't distinguish an
 * explicit `--yes=false` from the omitted default, so we scan the raw argv (global
 * flags are position-independent) up to the first `--` operand terminator (see
 * {@link argsBeforeOperandTerminator}), skipping tokens consumed as another flag's
 * value (see {@link nonValueConsumedTokens}). Only `--yes=false` needs special
 * handling: for `--yes` / `--yes=true` the flag is already `true`, so `flag || env`
 * matches Go, and for an omitted flag the env fallback matches Go. Reading the raw
 * argv also sidesteps however the CLI parser coerces `--yes=false`.
 */
const yesFlagExplicitlyFalse = (args: ReadonlyArray<string>): boolean =>
  nonValueConsumedTokens(argsBeforeOperandTerminator(args)).some(
    (arg) => arg.startsWith("--yes=") && PFLAG_FALSE_VALUES.has(arg.slice("--yes=".length)),
  );

/**
 * `--yes` resolved with Go's viper `AutomaticEnv` fallback: when the flag is not
 * passed, `SUPABASE_YES` is honored (`apps/cli-go/cmd/root.go:318-320` binds
 * every persistent flag, so `console.PromptYesNo` reading `viper.GetBool("YES")`
 * picks up the env var). An explicit `--yes` — including `--yes=false` — wins over
 * the env, matching viper's bound-pflag precedence. Prefer this over reading
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
 * project env before prompting (`migration down`, `migration repair --all`). Go runs
 * `loadNestedEnv` — `godotenv.Load`, which only sets keys absent from the shell env —
 * inside `ParseDatabaseConfig` before `PromptYesNo` reads `viper.GetBool("YES")`
 * (`pkg/config/config.go:701`, `internal/utils/console.go:71`), so a `SUPABASE_YES` set
 * only in `supabase/.env` auto-confirms. Shell *presence* — any value, including `false`,
 * empty, or garbage — suppresses the file value entirely (see
 * {@link viperEnvBoolWithProjectFallback}). An explicit `--yes` (including
 * `--yes=false`) wins over both. `projectEnv` is the loaded map from
 * `loadProjectEnv`.
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
 * Resolves the raw argv's *last* explicit `--experimental` occurrence to a boolean, or
 * `undefined` when the flag never appears before the first `--` operand terminator (see
 * {@link argsBeforeOperandTerminator}). `--experimental` is bound to viper the same way
 * `--yes` is (`apps/cli-go/cmd/root.go:318-334`): pflag/viper share ONE variable per flag,
 * so repeated occurrences collapse to whichever `Set()` call happened LAST — verified
 * empirically against the pinned `apps/cli-go` cobra@v1.10.2/pflag@v1.0.10/viper@v1.21.0
 * versions (`--experimental=false --experimental=true` resolves `viper.GetBool` to `true`,
 * and `--experimental=true --experimental=false` resolves to `false`). A plain
 * "does any occurrence say false" scan gets this backwards for the first ordering — it
 * would report `false` even though the final, authoritative value is `true` — so this
 * scans in argv order and keeps overwriting the result, same pattern as
 * {@link resolveDeclarativeFromArgs} (`diff-engine.ts:94-104`) uses for
 * `--declarative`/`--use-pg-delta`. `ExperimentalFlag` alone can't be used here: a
 * plain boolean can't distinguish an explicit `--experimental=false` from the omitted
 * default, and (independently) this CLI's flag parser resolves a repeated flag from its
 * FIRST occurrence rather than pflag's last-occurrence-wins, so the caller must reread
 * the raw argv rather than trust the parsed flag whenever `--experimental` is set at all.
 * Tokens consumed as another (local) flag's value are skipped (see
 * {@link nonValueConsumedTokens}) so e.g. `db pull --password --experimental=false` — where
 * pflag treats `--experimental=false` as `--password`'s space-separated value, not a changed
 * `--experimental` — doesn't falsely report an explicit occurrence.
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
 * `--experimental` resolved with Go's viper `AutomaticEnv` fallback: the gate in
 * `rootCmd.PersistentPreRunE` reads `viper.GetBool("EXPERIMENTAL")`
 * (`apps/cli-go/cmd/root.go:94`), so `SUPABASE_EXPERIMENTAL` enables experimental
 * commands just like the flag. An explicit `--experimental` — including
 * `--experimental=false`, and the last of a repeated flag — wins over the env, matching
 * viper's bound-pflag precedence.
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
 * `db schema declarative generate`/`sync`). Go's `ParseDatabaseConfig` /
 * `dbDeclarativeCmd.PersistentPreRunE` run `loadNestedEnv` — `godotenv.Load`, which only
 * sets keys absent from the shell env — before reading `viper.GetBool("EXPERIMENTAL")`, so
 * a `SUPABASE_EXPERIMENTAL` set only in `supabase/.env` enables the experimental path.
 * Shell *presence* — any value, including `false`, empty, or garbage — suppresses the file
 * value entirely (see {@link viperEnvBoolWithProjectFallback}); an explicit
 * `--experimental` — including `--experimental=false`, and the last of a repeated flag —
 * wins over both, matching viper's bound-pflag precedence. `projectEnv` is the loaded map
 * from `loadProjectEnv`.
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
 * True when the LAST `--debug`/`--debug=<value>` occurrence in argv resolves to a pflag `false`
 * (`PFLAG_FALSE_VALUES`, matching `ParseBool`'s false set). pflag's `Value.Set` runs for every
 * occurrence in argv order, so the last one wins: `--debug=false --debug=true` (or a trailing
 * bare `--debug`) is `true` to Go/pflag, not `false` — the Effect parser itself resolves repeats
 * first-wins instead (binary-verified precedent for this exact pflag-vs-Effect divergence:
 * `apps/cli/src/commands/sso/sso.pflag-reconcile.ts:306-321`). `--debug` is bound to
 * viper the same way as `--yes`/`--experimental` (`apps/cli-go/cmd/root.go:318-334`).
 * {@link yesFlagExplicitlyFalse}/{@link experimentalFlagExplicitlyFalse} above have
 * the identical `Array.some` "any occurrence is false" gap (review: PRRT_kwDOErm0O86XKYiG) —
 * left as-is here as a pre-existing, cross-cutting fix spanning those two flags too, not folded
 * into this port (same scoping precedent as this file's own {@link resolveDebugWithProjectEnv}
 * doc comment for existing `DebugFlag` call sites). Like those siblings, this scans only the
 * flag-parsing region (see {@link argsBeforeOperandTerminator}) and skips tokens pflag would
 * consume as another flag's value (see {@link nonValueConsumedTokens}) — `db pull -- --debug=false`
 * and `db pull --password --debug=false` leave `--debug` unchanged to pflag, so `SUPABASE_DEBUG`
 * must still win.
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
 * `--debug` resolved with Go's viper `AutomaticEnv` fallback (EVERY Go debug read goes through
 * `viper.GetBool("DEBUG")` — never the bare pflag — across the whole Go CLI, `apps/cli-go/cmd/
 * root.go:122,289`, `internal/utils/{connect,docker,edgeruntime,logger}.go`,
 * `internal/pgdelta/apply.go:332,342`, …) AND the project `.env` consulted too, for debug-gated
 * behavior that runs downstream of a command that has already loaded the nested project env
 * (e.g. `applyDeclarativePgDelta`, reached by `db diff`/`db pull` after
 * `ParseDatabaseConfig`; `buildShadowCatalogInputs`, reached by `db diff --from/--to
 * migrations` and `db schema declarative sync`). Go's `Config.Load` -> `loadNestedEnv` calls
 * `godotenv.Load`, which `os.Setenv`s every project `.env` key not already present in the shell
 * env (`godotenv@v1.5.1/godotenv.go:184-200`) — a REAL process-wide mutation that persists for
 * the rest of that Go process, so a later `viper.GetBool("DEBUG")` (e.g.
 * `pgdelta.ApplyDeclarative`, `apply.go:332,342`) sees a `SUPABASE_DEBUG` set only in
 * `supabase/.env`. This port's own `loadProjectEnv` is deliberately pure (no
 * `process.env` side effect, see its doc comment), so callers that need that same env-file
 * value for a `viper.GetBool`-shaped read must pass the loaded map through explicitly instead
 * — same shape as {@link resolveYesWithProjectEnv}/
 * {@link resolveExperimentalWithProjectEnv} above (review: PRRT_kwDOErm0O86XL_oz).
 * Shell *presence* — any value, including `false`, empty, or garbage — suppresses the file
 * value entirely; an explicit `--debug` — including `--debug=false` — wins over both, matching
 * viper's bound-pflag precedence. `projectEnv` is the loaded map from `loadProjectEnv`
 * (or `readDbToml`'s re-export of it). Existing bare {@link DebugFlag} call sites
 * are unaffected — this is additive, for call sites that opt in.
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
