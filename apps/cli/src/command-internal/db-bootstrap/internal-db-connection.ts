/**
 * The fixed, in-Docker-network Postgres address every service container (Realtime, PostgREST,
 * Storage) reaches Postgres at.
 *
 * This differs from `LocalConfigValues.dbUrl` (`local-config-values.ts`), the host-facing
 * address `status`/`stop` print for a user's own `psql` client via Docker's published port
 * mapping. Containers instead reach Postgres via its Docker service name on the unpublished,
 * always-5432 internal port; the two share a value only by coincidence.
 */

/** Always 5432 — not the user-configurable `db.port`. */
export const START_INTERNAL_DB_PORT = 5432;

/** Always `"postgres"`, never configurable. */
export const START_INTERNAL_DB_NAME = "postgres";

/**
 * Extracts the raw database password from the already-resolved `LocalConfigValues.dbUrl`.
 *
 * Returns the raw, decoded password rather than the URI's percent-encoded userinfo octets:
 * plain-env consumers (Realtime's `DB_PASSWORD`) need the decoded value, while URI re-embedders
 * ({@link startInternalDbUrl}) re-encode it themselves. Falls back to the undecoded value if the
 * userinfo was never percent-encoded (a raw `%` would throw).
 */
export function startInternalDbPassword(dbUrl: string): string {
  const encoded = new URL(dbUrl).password;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/**
 * `<role>:<password>@<dbHost>:5432/postgres` — the shape of every container-to-container
 * Postgres URI built for a specific role.
 *
 * `dbPassword` must be the raw password ({@link startInternalDbPassword}); it is percent-encoded
 * here so the consuming service's URI parser decodes it back to the same value.
 */
export function startInternalDbUrl(role: string, dbHost: string, dbPassword: string): string {
  return `postgresql://${role}:${encodeURIComponent(dbPassword)}@${dbHost}:${START_INTERNAL_DB_PORT}/${START_INTERNAL_DB_NAME}`;
}
