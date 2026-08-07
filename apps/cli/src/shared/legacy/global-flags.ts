import { Effect, Option } from "effect";
import { Flag, GlobalFlag } from "effect/unstable/cli";

import { CliArgs } from "../cli/cli-args.service.ts";
import {
  VALUE_CONSUMING_LONG_FLAGS,
  VALUE_CONSUMING_SHORT_FLAGS,
} from "../../legacy/shared/legacy-db-target-flags.ts";
import { legacyViperEnvBool, legacyViperEnvBoolWithProjectFallback } from "./legacy-viper-env.ts";

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
// `apps/cli-go/cmd/root.go:324-333` — this text is directly user-visible now
// that native shell completion (CLI-1965) surfaces it in `__complete`
// candidate descriptions, where a prior Go-binary passthrough used to emit
// Go's own text byte-for-byte; before that, this only reached the TS-native
// `--help` renderer, whose overall layout already diverges from cobra's, so
// the mismatch was harder to notice (CLI-1965 review finding).
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
    Flag.withDescription("output format of status variables"),
    Flag.optional,
  ),
});

export const LegacyProfileFlag = GlobalFlag.setting("profile")({
  flag: Flag.string("profile").pipe(
    Flag.withDescription("use a specific profile for connecting to Supabase API"),
    Flag.withDefault("supabase"),
  ),
});

export const LegacyDebugFlag = GlobalFlag.setting("debug")({
  flag: Flag.boolean("debug").pipe(Flag.withDescription("output debug logs to stderr")),
});

export const LegacyWorkdirFlag = GlobalFlag.setting("workdir")({
  flag: Flag.string("workdir").pipe(
    Flag.withDescription("path to a Supabase project directory"),
    Flag.optional,
  ),
});

export const LegacyExperimentalFlag = GlobalFlag.setting("experimental")({
  flag: Flag.boolean("experimental").pipe(Flag.withDescription("enable experimental features")),
});

export const LegacyNetworkIdFlag = GlobalFlag.setting("network-id")({
  flag: Flag.string("network-id").pipe(
    Flag.withDescription("use the specified docker network instead of a generated one"),
    Flag.optional,
  ),
});

export const LegacyYesFlag = GlobalFlag.setting("yes")({
  flag: Flag.boolean("yes").pipe(Flag.withDescription("answer yes to all prompts")),
});

export const LegacyDnsResolverFlag = GlobalFlag.setting("dns-resolver")({
  flag: Flag.choice("dns-resolver", ["native", "https"] as const).pipe(
    Flag.withDescription("lookup domain names using the specified resolver"),
    Flag.withDefault("native" as const),
  ),
});

export const LegacyCreateTicketFlag = GlobalFlag.setting("create-ticket")({
  flag: Flag.boolean("create-ticket").pipe(
    Flag.withDescription("create a support ticket for any CLI error"),
  ),
});

export const LegacyAgentFlag = GlobalFlag.setting("agent")({
  flag: Flag.choice("agent", ["auto", "yes", "no"] as const).pipe(
    Flag.withDescription("Override agent detection: yes, no, or auto (default auto)"),
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

/**
 * Resolves the current value of every global/persistent flag above, keyed by
 * its own CLI flag name (each flag's `.id`, e.g. `debug`, `workdir`). Used by
 * `legacy/telemetry/legacy-command-instrumentation.ts` to mirror Go's
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
 * root (`legacy/cli/root.ts`).
 *
 * Reads each flag individually (rather than looping `LEGACY_GLOBAL_FLAGS`)
 * because each `Setting<Id, A>` has a distinct value type `A` — a homogeneous
 * loop widens the union in a way `Effect.serviceOption` can't resolve back to
 * a single service lookup without an `as` cast, which this codebase forbids.
 * `global-flags.unit.test.ts` asserts the resolved id set stays exactly in
 * sync with `LEGACY_GLOBAL_FLAGS` — extend both together when adding a new
 * global flag.
 */
export const legacyGlobalFlagValues = Effect.gen(function* () {
  const values: Record<string, unknown> = {};
  const setIfPresent = (id: string, option: Option.Option<unknown>) => {
    if (Option.isSome(option)) values[id] = option.value;
  };
  setIfPresent(LegacyAgentFlag.id, yield* Effect.serviceOption(LegacyAgentFlag));
  setIfPresent(LegacyCreateTicketFlag.id, yield* Effect.serviceOption(LegacyCreateTicketFlag));
  setIfPresent(LegacyDebugFlag.id, yield* Effect.serviceOption(LegacyDebugFlag));
  setIfPresent(LegacyDnsResolverFlag.id, yield* Effect.serviceOption(LegacyDnsResolverFlag));
  setIfPresent(LegacyExperimentalFlag.id, yield* Effect.serviceOption(LegacyExperimentalFlag));
  setIfPresent(LegacyNetworkIdFlag.id, yield* Effect.serviceOption(LegacyNetworkIdFlag));
  setIfPresent(LegacyOutputFlag.id, yield* Effect.serviceOption(LegacyOutputFlag));
  setIfPresent(LegacyProfileFlag.id, yield* Effect.serviceOption(LegacyProfileFlag));
  setIfPresent(LegacyWorkdirFlag.id, yield* Effect.serviceOption(LegacyWorkdirFlag));
  setIfPresent(LegacyYesFlag.id, yield* Effect.serviceOption(LegacyYesFlag));
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
 * `resolveLegacyDbTargetFlags`/`legacyChangedLinkedLocalFlags`
 * (`legacy/shared/legacy-db-target-flags.ts`) and `extractChangedFlagNames`
 * (`legacy/telemetry/legacy-command-instrumentation.ts`), which this reuses the
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
 * `AutomaticEnv`; `LegacyYesFlag` is a plain boolean that can't distinguish an
 * explicit `--yes=false` from the omitted default, so we scan the raw argv (global
 * flags are position-independent) up to the first `--` operand terminator (see
 * {@link argsBeforeOperandTerminator}), skipping tokens consumed as another flag's
 * value (see {@link nonValueConsumedTokens}). Only `--yes=false` needs special
 * handling: for `--yes` / `--yes=true` the flag is already `true`, so `flag || env`
 * matches Go, and for an omitted flag the env fallback matches Go. Reading the raw
 * argv also sidesteps however the CLI parser coerces `--yes=false`.
 */
const legacyYesFlagExplicitlyFalse = (args: ReadonlyArray<string>): boolean =>
  nonValueConsumedTokens(argsBeforeOperandTerminator(args)).some(
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
 * `loadNestedEnv` — `godotenv.Load`, which only sets keys absent from the shell env —
 * inside `ParseDatabaseConfig` before `PromptYesNo` reads `viper.GetBool("YES")`
 * (`pkg/config/config.go:701`, `internal/utils/console.go:71`), so a `SUPABASE_YES` set
 * only in `supabase/.env` auto-confirms. Shell *presence* — any value, including `false`,
 * empty, or garbage — suppresses the file value entirely (see
 * {@link legacyViperEnvBoolWithProjectFallback}). An explicit `--yes` (including
 * `--yes=false`) wins over both. `projectEnv` is the loaded map from
 * `legacyLoadProjectEnv`.
 */
export const legacyResolveYesWithProjectEnv = (projectEnv: Record<string, string>) =>
  Effect.gen(function* () {
    const flag = yield* LegacyYesFlag;
    const cliArgs = yield* CliArgs;
    if (legacyYesFlagExplicitlyFalse(cliArgs.args)) {
      return false;
    }
    return flag || legacyViperEnvBoolWithProjectFallback("SUPABASE_YES", projectEnv);
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
 * {@link legacyResolveDeclarativeFromArgs} (`legacy-diff-engine.ts:94-104`) uses for
 * `--declarative`/`--use-pg-delta`. `LegacyExperimentalFlag` alone can't be used here: a
 * plain boolean can't distinguish an explicit `--experimental=false` from the omitted
 * default, and (independently) this CLI's flag parser resolves a repeated flag from its
 * FIRST occurrence rather than pflag's last-occurrence-wins, so the caller must reread
 * the raw argv rather than trust the parsed flag whenever `--experimental` is set at all.
 * Tokens consumed as another (local) flag's value are skipped (see
 * {@link nonValueConsumedTokens}) so e.g. `db pull --password --experimental=false` — where
 * pflag treats `--experimental=false` as `--password`'s space-separated value, not a changed
 * `--experimental` — doesn't falsely report an explicit occurrence.
 */
const legacyExperimentalFlagFromArgs = (args: ReadonlyArray<string>): boolean | undefined => {
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
export const legacyResolveExperimental = Effect.gen(function* () {
  const flag = yield* LegacyExperimentalFlag;
  const cliArgs = yield* CliArgs;
  const explicit = legacyExperimentalFlagFromArgs(cliArgs.args);
  if (explicit !== undefined) {
    return explicit;
  }
  return flag || legacyViperEnvBool("SUPABASE_EXPERIMENTAL");
});

/**
 * `--experimental` resolved with the project `.env` consulted too, for commands that load the
 * nested project env before branching on the experimental gate (`db reset`,
 * `db schema declarative generate`/`sync`). Go's `ParseDatabaseConfig` /
 * `dbDeclarativeCmd.PersistentPreRunE` run `loadNestedEnv` — `godotenv.Load`, which only
 * sets keys absent from the shell env — before reading `viper.GetBool("EXPERIMENTAL")`, so
 * a `SUPABASE_EXPERIMENTAL` set only in `supabase/.env` enables the experimental path.
 * Shell *presence* — any value, including `false`, empty, or garbage — suppresses the file
 * value entirely (see {@link legacyViperEnvBoolWithProjectFallback}); an explicit
 * `--experimental` — including `--experimental=false`, and the last of a repeated flag —
 * wins over both, matching viper's bound-pflag precedence. `projectEnv` is the loaded map
 * from `legacyLoadProjectEnv`.
 */
export const legacyResolveExperimentalWithProjectEnv = (projectEnv: Record<string, string>) =>
  Effect.gen(function* () {
    const flag = yield* LegacyExperimentalFlag;
    const cliArgs = yield* CliArgs;
    const explicit = legacyExperimentalFlagFromArgs(cliArgs.args);
    if (explicit !== undefined) {
      return explicit;
    }
    return flag || legacyViperEnvBoolWithProjectFallback("SUPABASE_EXPERIMENTAL", projectEnv);
  });

/**
 * True when the LAST `--debug`/`--debug=<value>` occurrence in argv resolves to a pflag `false`
 * (`PFLAG_FALSE_VALUES`, matching `ParseBool`'s false set). pflag's `Value.Set` runs for every
 * occurrence in argv order, so the last one wins: `--debug=false --debug=true` (or a trailing
 * bare `--debug`) is `true` to Go/pflag, not `false` — the Effect parser itself resolves repeats
 * first-wins instead (binary-verified precedent for this exact pflag-vs-Effect divergence:
 * `apps/cli/src/legacy/commands/sso/sso.pflag-reconcile.ts:306-321`). `--debug` is bound to
 * viper the same way as `--yes`/`--experimental` (`apps/cli-go/cmd/root.go:318-334`).
 * {@link legacyYesFlagExplicitlyFalse}/{@link legacyExperimentalFlagExplicitlyFalse} above have
 * the identical `Array.some` "any occurrence is false" gap (review: PRRT_kwDOErm0O86XKYiG) —
 * left as-is here as a pre-existing, cross-cutting fix spanning those two flags too, not folded
 * into this port (same scoping precedent as this file's own {@link legacyResolveDebug} doc
 * comment for existing `LegacyDebugFlag` call sites).
 */
const legacyDebugFlagExplicitlyFalse = (args: ReadonlyArray<string>): boolean => {
  let lastExplicitlyFalse = false;
  for (const arg of args) {
    if (arg === "--debug") {
      lastExplicitlyFalse = false;
    } else if (arg.startsWith("--debug=")) {
      lastExplicitlyFalse = PFLAG_FALSE_VALUES.has(arg.slice("--debug=".length));
    }
  }
  return lastExplicitlyFalse;
};

/**
 * `--debug` resolved with Go's viper `AutomaticEnv` fallback: EVERY Go debug read goes
 * through `viper.GetBool("DEBUG")` — never the bare pflag — across the whole Go CLI
 * (`apps/cli-go/cmd/root.go:122,289`, `internal/utils/{connect,docker,edgeruntime,logger}.go`,
 * `internal/pgdelta/apply.go:332,342`, …), so `SUPABASE_DEBUG` enables debug output exactly
 * like `--debug`. An explicit `--debug` — including `--debug=false` — wins over the env,
 * matching viper's bound-pflag precedence. Mirrors {@link legacyResolveYes}/
 * {@link legacyResolveExperimental} above. Prefer this over reading {@link LegacyDebugFlag}
 * directly for any NEW debug-gated behavior that has a direct, single-call-site Go
 * counterpart reading `viper.GetBool("DEBUG")` (review: PRRT_kwDOErm0O86XDr4V) — existing
 * `LegacyDebugFlag` call sites predate this helper and are a separate, broader cross-cutting
 * cleanup, not folded in here.
 */
export const legacyResolveDebug = Effect.gen(function* () {
  const flag = yield* LegacyDebugFlag;
  const cliArgs = yield* CliArgs;
  if (legacyDebugFlagExplicitlyFalse(cliArgs.args)) {
    return false;
  }
  return flag || legacyViperEnvBool("SUPABASE_DEBUG");
});

/**
 * `--debug` resolved with the project `.env` consulted too, for NEW debug-gated behavior that
 * runs downstream of a command that has already loaded the nested project env (e.g.
 * `legacyApplyDeclarativePgDelta`, reached by `db diff`/`db pull` after `ParseDatabaseConfig`).
 * Go's `Config.Load` -> `loadNestedEnv` calls `godotenv.Load`, which `os.Setenv`s every project
 * `.env` key not already present in the shell env (`godotenv@v1.5.1/godotenv.go:184-200`) — a
 * REAL process-wide mutation that persists for the rest of that Go process, so a later
 * `viper.GetBool("DEBUG")` (e.g. `pgdelta.ApplyDeclarative`, `apply.go:332,342`) sees a
 * `SUPABASE_DEBUG` set only in `supabase/.env`. This port's own `legacyLoadProjectEnv` is
 * deliberately pure (no `process.env` side effect, see its doc comment), so callers that need
 * that same env-file value for a `viper.GetBool`-shaped read must pass the loaded map through
 * explicitly instead — same shape as {@link legacyResolveYesWithProjectEnv}/
 * {@link legacyResolveExperimentalWithProjectEnv} above (review: PRRT_kwDOErm0O86XL_oz).
 * Shell *presence* — any value, including `false`, empty, or garbage — suppresses the file
 * value entirely; an explicit `--debug` — including `--debug=false` — wins over both, matching
 * viper's bound-pflag precedence. `projectEnv` is the loaded map from `legacyLoadProjectEnv`
 * (or `legacyReadDbToml`'s re-export of it). Existing bare {@link LegacyDebugFlag}/
 * {@link legacyResolveDebug} call sites are unaffected — this is additive, for call sites that
 * opt in.
 */
export const legacyResolveDebugWithProjectEnv = (projectEnv: Record<string, string>) =>
  Effect.gen(function* () {
    const flag = yield* LegacyDebugFlag;
    const cliArgs = yield* CliArgs;
    if (legacyDebugFlagExplicitlyFalse(cliArgs.args)) {
      return false;
    }
    return flag || legacyViperEnvBoolWithProjectFallback("SUPABASE_DEBUG", projectEnv);
  });
