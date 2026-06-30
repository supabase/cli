/**
 * Go's root command binds every persistent flag to viper and enables
 * `AutomaticEnv` with the `SUPABASE` prefix and a `-`→`_` key replacer
 * (`apps/cli-go/cmd/root.go:318-320,334`):
 *
 * ```go
 * viper.SetEnvPrefix("SUPABASE")
 * viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_"))
 * viper.AutomaticEnv()
 * viper.BindPFlags(flags)
 * ```
 *
 * The net effect is that any global flag `--foo-bar` falls back to the
 * `SUPABASE_FOO_BAR` env var when the flag is absent. `viper.GetBool` casts the
 * env string via `strconv.ParseBool` (through `cast.ToBool`), which recognizes
 * exactly `1/t/T/TRUE/true/True` as true and `0/f/F/FALSE/false/False` as false;
 * any other value (including `yes`/`on`/empty/garbage) parses to an error that
 * `cast.ToBool` swallows to `false`.
 *
 * This helper reproduces `viper.GetBool` for a single bound boolean key so the
 * legacy shell honors `SUPABASE_YES`, `SUPABASE_EXPERIMENTAL`, etc. exactly like
 * the Go CLI. Effect CLI's flag parser carries no env binding, so callers OR the
 * parsed flag value with this read (flag-set wins, matching viper precedence).
 */

const LEGACY_VIPER_TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);

/** `viper.GetBool` truthiness for an already-resolved env value (see module doc). */
export function legacyViperBool(raw: string | undefined): boolean {
  return raw !== undefined && LEGACY_VIPER_TRUE.has(raw);
}

/** `viper.GetBool` for a single `SUPABASE_*` env var read from `process.env` (see module doc). */
export function legacyViperEnvBool(name: string): boolean {
  return legacyViperBool(process.env[name]);
}
