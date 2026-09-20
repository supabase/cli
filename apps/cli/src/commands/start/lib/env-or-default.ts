/**
 * Returns the env var if set, even to an empty string — unlike
 * `local-config-values.ts`'s `envOverride`, which treats an empty value as
 * unset. Falls back to `def` only when the var is absent. Reads
 * `process.env` directly, bypassing the `SUPABASE_`-prefixed decode-hook chain.
 */
export function envOrDefault(
  key: string,
  def: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): string {
  // oxlint-disable-next-line effecttsgo/process-env -- Windows env lookups are case-insensitive; the projectEnvValues snapshot is case-sensitive.
  return projectEnvValues?.[key] ?? process.env[key] ?? def;
}
