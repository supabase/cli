export interface ApiKeyEntry {
  readonly api_key?: string | null;
  readonly type?: string | null;
  readonly name: string;
  readonly secret_jwt_template?: Record<string, unknown> | null;
}

/**
 * Extracts the anon and service-role keys from an api-keys response:
 * `publishable` type → anon; `secret` type with `role=service_role` →
 * service_role; otherwise falls back to matching by legacy key name
 * (`anon`/`service_role`).
 */
export function extractServiceKeys(keys: ReadonlyArray<ApiKeyEntry>): {
  readonly anon: string;
  readonly serviceRole: string;
} {
  let anon = "";
  let serviceRole = "";
  for (const key of keys) {
    const value = key.api_key;
    if (value === undefined || value === null) continue;
    if (key.type === "publishable") {
      anon = value;
      continue;
    }
    if (key.type === "secret") {
      const role = key.secret_jwt_template?.["role"];
      if (typeof role === "string" && role.toLowerCase() === "service_role") {
        serviceRole = value;
      }
      continue;
    }
    if (key.name === "anon" && anon.length === 0) {
      anon = value;
    } else if (key.name === "service_role" && serviceRole.length === 0) {
      serviceRole = value;
    }
  }
  return { anon, serviceRole };
}
