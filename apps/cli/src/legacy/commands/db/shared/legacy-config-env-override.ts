/**
 * Applies Go's viper `AutomaticEnv` override for a boolean config field.
 *
 * Go loads config through viper with `SetEnvPrefix("SUPABASE")` + `AutomaticEnv()`
 * and an EnvKeyReplacer of `.`→`_` (`pkg/config/config.go:529-535`), so any config
 * key is overridable by `SUPABASE_<UPPER_SNAKE_KEY>` (e.g. `db.migrations.enabled` →
 * `SUPABASE_DB_MIGRATIONS_ENABLED`, `db.seed.enabled` → `SUPABASE_DB_SEED_ENABLED`).
 * `@supabase/config` only interpolates explicit `env(...)` references in values, not
 * this implicit AutomaticEnv override, so apply it here for the db push / db reset
 * migration + seed gates to match Go.
 *
 * An UNSET or EMPTY env var leaves the config/default value in force: viper's
 * `AutomaticEnv` is configured without `AllowEmptyEnv` (config.go:529-535), so it
 * ignores an env var whose value is `""` and falls back to the loaded config.
 *
 * For a non-empty value, mirrors viper's `GetBool` → `cast.ToBool`
 * (`strconv.ParseBool`): only `1/t/T/TRUE/true/True` are truthy; any other
 * (unparseable) token is false (cast swallows the parse error).
 */
const VIPER_TRUE_VALUES = new Set(["1", "t", "T", "TRUE", "true", "True"]);

function legacyConfigBoolEnvOverride(envKey: string, configValue: boolean): boolean {
  const override = process.env[envKey];
  // Unset or empty → no override (Go's AutomaticEnv without AllowEmptyEnv).
  if (override === undefined || override === "") return configValue;
  return VIPER_TRUE_VALUES.has(override);
}

/** `db.migrations.enabled`, honoring `SUPABASE_DB_MIGRATIONS_ENABLED`. */
export function legacyMigrationsEnabled(configEnabled: boolean): boolean {
  return legacyConfigBoolEnvOverride("SUPABASE_DB_MIGRATIONS_ENABLED", configEnabled);
}

/** `db.seed.enabled`, honoring `SUPABASE_DB_SEED_ENABLED`. */
export function legacySeedEnabled(configEnabled: boolean): boolean {
  return legacyConfigBoolEnvOverride("SUPABASE_DB_SEED_ENABLED", configEnabled);
}
