// Pure diff-engine resolution shared by `db diff` and `db pull`. Mirrors the
// three Go helpers in `apps/cli-go/cmd/db.go:375-401` so engine selection stays
// byte-identical to the Go CLI. No Effect / service dependencies — unit-tested
// directly.

/**
 * Whether pg-delta is the active default engine. Mirrors Go's `shouldUsePgDelta`
 * (`db.go:375-376`): `utils.IsPgDeltaEnabled() || usePgDelta || viper.GetBool("EXPERIMENTAL_PG_DELTA")`.
 * The three inputs are the resolved config flag (`[experimental.pgdelta].enabled`),
 * the command's `--use-pg-delta` flag, and the `SUPABASE_EXPERIMENTAL_PG_DELTA`
 * env var.
 */
export function legacyShouldUsePgDelta(inputs: {
  readonly configEnabled: boolean;
  readonly usePgDeltaFlag: boolean;
  readonly envEnabled: boolean;
}): boolean {
  return inputs.configEnabled || inputs.usePgDeltaFlag || inputs.envEnabled;
}

/**
 * Reports whether `db diff` should run in pg-delta mode. Mirrors Go's
 * `resolveDiffEngine` (`db.go:385-390`): an explicit `--use-migra`,
 * `--use-pgadmin`, or `--use-pg-schema` is an authoritative rollback that clears
 * pg-delta mode; `--use-migra` defaults to true so only an explicit pass
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
 * step. Mirrors Go's `resolvePullDiffEngine` (`db.go:396-401`): an explicit
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
