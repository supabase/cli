export interface LegacyApiKeyEntry {
  readonly api_key?: string | null;
  readonly type?: string | null;
  readonly name: string;
  readonly secret_jwt_template?: Record<string, unknown> | null;
}

/**
 * Mirrors `tenant.NewApiKey` (`apps/cli-go/internal/utils/tenant/client.go:28-57`):
 * `publishable` -> anon, `secret` with `role=service_role` -> service_role, else the
 * legacy name-based fallback (`anon` / `service_role`).
 *
 * Shared by `link` (which writes the service-role key into `.temp` version probes)
 * and `bootstrap` (which derives the anon key for the generated `.env`).
 */
export function legacyExtractServiceKeys(keys: ReadonlyArray<LegacyApiKeyEntry>): {
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
