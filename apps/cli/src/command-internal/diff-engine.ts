// Pure diff-engine resolution shared by `db diff` and `db pull`. No Effect / service
// dependencies — unit-tested directly.

export const schemaPathsTransitionWarning =
  "WARNING: [db.migrations].schema_paths no longer changes the migrations baseline used by db diff or migration-style db pull. These commands always compare local migrations with the selected database. Use `supabase db schema declarative sync` to compare declarative schema files.\n";

/**
 * Whether pg-delta is the active default engine: the resolved config flag
 * (`[experimental.pgdelta].enabled`), the command's `--use-pg-delta` flag, or the
 * `SUPABASE_EXPERIMENTAL_PG_DELTA` env var, whichever is set.
 */
export function shouldUsePgDelta(inputs: {
  readonly configEnabled: boolean;
  readonly usePgDeltaFlag: boolean;
  readonly envEnabled: boolean;
}): boolean {
  return inputs.configEnabled || inputs.usePgDeltaFlag || inputs.envEnabled;
}

/**
 * Reports whether `db diff` should run in pg-delta mode. An explicit `--use-migra`,
 * `--use-pgadmin`, or `--use-pg-schema` is an authoritative rollback that clears pg-delta mode;
 * `--use-migra` defaults to true, so only an explicit pass (`useMigraChanged`) counts as opting
 * out.
 */
export function resolveDiffEngine(inputs: {
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
 * Selects whether migration-style `db pull` uses pg-delta for the shadow diff step. An explicit
 * `--diff-engine` always wins (so `--diff-engine migra` is an authoritative rollback even when
 * pg-delta is enabled in config); otherwise the default follows the active engine.
 */
export function resolvePullDiffEngine(inputs: {
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
 * Parses a boolean env var: accepts exactly `1`, `t`, `T`, `TRUE`, `true`, `True` as true, and
 * every other value (including unparseable strings and unset) as false.
 */
export function parseBoolEnv(raw: string | undefined): boolean {
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
 * Resolves `db pull` declarative mode from raw argv: `--declarative` and the deprecated
 * `--use-pg-delta` alias bind to the same outcome, so the last occurrence in argv wins (ORing
 * the two would wrongly select declarative mode from either flag alone). A bare flag is `true`;
 * `--flag=value` parses with {@link parseBoolEnv}'s true-set — a following space-separated token
 * is never consumed as a value. Returns `undefined` when neither flag is present.
 */
export function resolveDeclarativeFromArgs(args: ReadonlyArray<string>): boolean | undefined {
  const FLAG_PATTERN = /^--(?:declarative|use-pg-delta)(?:=(.*))?$/u;
  let result: boolean | undefined;
  for (const arg of args) {
    if (arg === "--") break;
    const match = FLAG_PATTERN.exec(arg);
    if (match === null) continue;
    result = match[1] === undefined ? true : parseBoolEnv(match[1]);
  }
  return result;
}
