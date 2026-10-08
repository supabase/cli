import { ambientEnvironment } from "../../../shared/config/cli-config-provider.layer.ts";

/**
 * Returns the env var if set, even to an empty string, unlike the config
 * snapshot, which treats an empty value as unset. Falls back to `def` only
 * when the var is absent. Reads
 * the ambient environment directly, bypassing the `SUPABASE_`-prefixed decode-hook chain.
 * `env` defaults to the live ambient environment rather than a copied snapshot:
 * Windows env lookups are case-insensitive; a snapshot record is not.
 */
export function envOrDefault(
  key: string,
  def: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
  env: Readonly<Record<string, string | undefined>> = ambientEnvironment(),
): string {
  return projectEnvValues?.[key] ?? env[key] ?? def;
}
