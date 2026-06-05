import type { ApiKeyResponse } from "@supabase/api/effect";

type ApiKey = typeof ApiKeyResponse.Type;

/**
 * Masking placeholder Go substitutes for a nullable-null api key value
 * (`apps/cli-go/internal/projects/apiKeys/api_keys.go:61-66`).
 */
const API_KEY_MASK = "******";

/**
 * Reproduces Go's `apiKeys.toValue` (`api_keys.go:61-66`): return the api key
 * value, or the `******` mask when the value is nullable-null / absent.
 */
export function apiKeyValue(value: string | null | undefined): string {
  return value === undefined || value === null ? API_KEY_MASK : value;
}

/**
 * Reproduces Go's `apiKeys.ToEnv` (`api_keys.go:51-66`):
 * uppercase the name, wrap as `SUPABASE_<NAME>_KEY`, fall back to `"******"`
 * when the api_key value is nullable-null. Shared by `branches get` and
 * `projects api-keys`.
 */
export function apiKeysToEnv(keys: ReadonlyArray<ApiKey>): Record<string, string> {
  const envs: Record<string, string> = {};
  for (const entry of keys) {
    const key = `SUPABASE_${entry.name.toUpperCase()}_KEY`;
    envs[key] = apiKeyValue(entry.api_key);
  }
  return envs;
}
