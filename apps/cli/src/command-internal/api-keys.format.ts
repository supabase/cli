import type { ApiKeyResponse } from "@supabase/api/effect";

type ApiKey = typeof ApiKeyResponse.Type;

/** Placeholder returned for a null or missing api key value. */
const API_KEY_MASK = "******";

/** Returns the api key value, or the mask when it's null or absent. */
export function apiKeyValue(value: string | null | undefined): string {
  return value === undefined || value === null ? API_KEY_MASK : value;
}

function envSuffix(entry: ApiKey): string {
  if (entry.type === "publishable" && entry.name === "default") {
    return "PUBLISHABLE";
  }
  return entry.name.toUpperCase();
}

/**
 * Builds `SUPABASE_<SUFFIX>_KEY` env entries from api keys, uppercasing the name (the
 * default publishable key maps to `PUBLISHABLE`). Shared by `branches get` and
 * `projects api-keys`.
 */
export function apiKeysToEnv(keys: ReadonlyArray<ApiKey>): Record<string, string> {
  const envs: Record<string, string> = {};
  for (const entry of keys) {
    const key = `SUPABASE_${envSuffix(entry)}_KEY`;
    envs[key] = apiKeyValue(entry.api_key);
  }
  return envs;
}
