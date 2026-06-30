/**
 * Resolves whether DB migrations are enabled, honoring Go's viper env override.
 *
 * Go loads config through viper with `SetEnvPrefix("SUPABASE")` + `AutomaticEnv()`
 * and an EnvKeyReplacer of `.`→`_` (`pkg/config/config.go:529-535`), so the env var
 * `SUPABASE_DB_MIGRATIONS_ENABLED` overrides the TOML `db.migrations.enabled` value
 * for every command (e.g. `db push` / remote `db reset` skip migrations when it is
 * `false`). `@supabase/config` only interpolates explicit `env(...)` references in
 * values, not this implicit AutomaticEnv override, so apply it here at the migration
 * gate to match Go.
 *
 * Mirrors viper's `GetBool` → `cast.ToBool` (`strconv.ParseBool`): only
 * `1/t/T/TRUE/true/True` are truthy; any other value — including an explicitly-set
 * empty string or an unparseable token — is false (cast swallows the parse error).
 */
const VIPER_TRUE_VALUES = new Set(["1", "t", "T", "TRUE", "true", "True"]);

export function legacyMigrationsEnabled(configEnabled: boolean): boolean {
  const override = process.env["SUPABASE_DB_MIGRATIONS_ENABLED"];
  if (override === undefined) return configEnabled;
  return VIPER_TRUE_VALUES.has(override);
}
