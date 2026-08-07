/**
 * The fixed, in-Docker-network Postgres address every `start`-created service
 * container (Realtime, PostgREST, Storage) reaches Postgres at, ported from
 * Go's `dbConfig := pgconn.Config{Host: utils.DbId, Port: 5432, User:
 * "postgres", Password: utils.Config.Db.Password, Database: "postgres"}`
 * (`apps/cli-go/internal/start/start.go:66-72`, threaded through `run()` as
 * `dbConfig`).
 *
 * This is deliberately NOT the same value as
 * `LegacyLocalConfigValues.dbUrl` (`legacy-local-config-values.ts`): that
 * field is `postgresql://postgres:<password>@<hostname>:<host-mapped db.port>/postgres`
 * — the HOST-facing address `status`/`stop` print for a user's own `psql`
 * client, reachable through Docker's published port mapping. Every
 * container-to-container env var in `start.go` instead reaches Postgres via
 * `utils.DbId` (the `db` container's own Docker name) on its unpublished,
 * always-5432 internal port — the two never share a value except by
 * coincidence (`db.port` happening to equal 5432).
 *
 * Hoisted here (`legacy/shared/db-bootstrap/`) per `apps/cli/CLAUDE.md`'s
 * "Hoist Before You Duplicate" rule: Realtime, PostgREST, and Storage's own
 * container-spec builders (`start/services/*.service.ts`) all need this
 * exact host/port/password derivation, and `db start` (a different command
 * family, `commands/db/start/`) needs it too since CLI-1954.
 */

/** Go's `dbConfig.Port` literal (`start.go:68`) — always 5432, never the configurable `db.port`. */
export const LEGACY_START_INTERNAL_DB_PORT = 5432;

/** Go's `dbConfig.Database` literal (`start.go:71`) — always `"postgres"`, never configurable. */
export const LEGACY_START_INTERNAL_DB_NAME = "postgres";

/**
 * Extracts `dbConfig.Password` (Go's `utils.Config.Db.Password`, `db.go:88` —
 * `toml:"-"`, never configurable, always the `"postgres"` literal default,
 * `pkg/config/config.go:459`) from the already-resolved
 * `LegacyLocalConfigValues.dbUrl` rather than re-deriving that default a
 * second time — `dbUrl`'s shape
 * (`postgresql://postgres:<password>@<hostname>:<port>/postgres`,
 * `legacyResolveLocalConfigValues`) always embeds the exact same password
 * value `dbConfig.Password` does, since both are sourced from the same
 * `config.Db.Password` field.
 */
export function legacyStartInternalDbPassword(dbUrl: string): string {
  return new URL(dbUrl).password;
}

/**
 * `<role>:<password>@<dbHost>:5432/postgres` — the shape of every
 * container-to-container Postgres URI `start.go` builds for a specific role
 * (PostgREST's `PGRST_DB_URI` as `authenticator`, Storage's `DATABASE_URL` as
 * `supabase_storage_admin`, Storage's vector-bucket default `VECTOR_DATABASE_URL`
 * as `postgres` — see `appendStorageVectorEnv`, `start.go:1487-1501`).
 */
export function legacyStartInternalDbUrl(role: string, dbHost: string, dbPassword: string): string {
  return `postgresql://${role}:${dbPassword}@${dbHost}:${LEGACY_START_INTERNAL_DB_PORT}/${LEGACY_START_INTERNAL_DB_NAME}`;
}
