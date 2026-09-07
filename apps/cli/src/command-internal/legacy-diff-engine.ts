// Pure diff-engine resolution shared by `db diff` and `db pull`. No Effect / service
// dependencies — unit-tested directly.

export const legacySchemaPathsTransitionWarning =
  "WARNING: [db.migrations].schema_paths no longer changes the migrations baseline used by db diff or migration-style db pull. These commands always compare local migrations with the selected database. Use `supabase db schema declarative sync` to compare declarative schema files.\n";

/**
 * Whether pg-delta is the active default engine. pg-delta is on unless the project
 * explicitly rolls back with `[experimental.pgdelta] enabled = false`; the command's
 * `--use-pg-delta` flag is a per-run opt-in that overrides that rollback. The historical
 * `SUPABASE_EXPERIMENTAL_PG_DELTA` opt-in env var is intentionally not an input: now
 * that pg-delta is the default it adds nothing when the config is on, and honoring a
 * stale opt-in would silently defeat the documented config rollback.
 */
export function legacyShouldUsePgDelta(inputs: {
  readonly configEnabled: boolean;
  readonly usePgDeltaFlag: boolean;
}): boolean {
  return inputs.configEnabled || inputs.usePgDeltaFlag;
}

/**
 * Reports whether `db diff` should run in pg-delta mode. Mirrors Go's
 * `resolveDiffEngine`: an explicit `--use-migra`,
 * `--use-pgadmin`, or `--use-pg-schema` is an authoritative rollback that clears
 * pg-delta mode. `--use-migra` is off unless passed, so only an explicit pass
 * (`useMigraChanged`) counts as opting out.
 */
export function legacyResolveDiffEngine(inputs: {
  readonly useMigraChanged: boolean;
  readonly usePgAdmin: boolean;
  readonly usePgSchema: boolean;
  readonly pgDeltaDefault: boolean;
}): boolean {
  if (inputs.useMigraChanged || inputs.usePgAdmin || inputs.usePgSchema) {
    return false;
  }
  return inputs.pgDeltaDefault;
}

/**
 * Selects whether migration-style `db pull` uses pg-delta for the shadow diff
 * step. Mirrors `resolvePullDiffEngine`: an explicit
 * `--diff-engine` always wins (so `--diff-engine migra` is an authoritative
 * rollback even when pg-delta is enabled in config); otherwise the default
 * follows the active engine.
 */
export function legacyResolvePullDiffEngine(inputs: {
  readonly engineFlagChanged: boolean;
  readonly engine: string;
  readonly pgDeltaDefault: boolean;
}): boolean {
  if (inputs.engineFlagChanged) {
    return inputs.engine === "pg-delta";
  }
  return inputs.pgDeltaDefault;
}

/**
 * Parses a `viper.GetBool`-style boolean env var. Go's viper delegates to
 * `strconv.ParseBool`, which accepts exactly `1 t T TRUE true True` as true and
 * treats every other value (including unparseable strings and unset) as false.
 */
export function legacyParseBoolEnv(raw: string | undefined): boolean {
  switch (raw) {
    case "1":
    case "t":
    case "T":
    case "TRUE":
    case "true":
    case "True":
      return true;
    default:
      return false;
  }
}

/**
 * Resolves `db pull` declarative mode from the raw argv, replicating pflag's
 * single-variable, last-occurrence-wins binding. Go binds BOTH `--declarative`
 * and the deprecated alias `--use-pg-delta` to the same `useDeclarative`
 * variable, so when both appear the LAST
 * occurrence in argv wins — e.g. `db pull --declarative --use-pg-delta=false`
 * ends in migration mode (`false`), and `--use-pg-delta --declarative=false`
 * likewise. OR-ing the two parsed booleans would instead take the declarative
 * export path for either invocation, diverging from Go.
 *
 * pflag bool flags are switches: a bare `--declarative` is `true`; `--flag=value`
 * parses `value` via `strconv.ParseBool` (same true-set as viper above). A
 * space-separated token after a bool flag is NOT consumed (it falls through as a
 * positional), so only the `=value` form carries a value. Tokens after the `--`
 * argv terminator are positionals, not flags. Returns `undefined` when neither
 * flag is present so the caller falls back to the Go default (`false`).
 */
export function legacyResolveDeclarativeFromArgs(args: ReadonlyArray<string>): boolean | undefined {
  const FLAG_PATTERN = /^--(?:declarative|use-pg-delta)(?:=(.*))?$/u;
  let result: boolean | undefined;
  for (const arg of args) {
    if (arg === "--") break;
    const match = FLAG_PATTERN.exec(arg);
    if (match === null) continue;
    result = match[1] === undefined ? true : legacyParseBoolEnv(match[1]);
  }
  return result;
}
