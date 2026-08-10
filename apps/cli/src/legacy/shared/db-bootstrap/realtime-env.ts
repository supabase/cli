/**
 * Realtime's env-var literal (Go's `start.go:909-929` `Env` slice) — shared by TWO Go call
 * sites, and therefore two TS ports: the long-running Realtime container
 * (`commands/start/services/realtime.service.ts`'s `legacyBuildRealtimeContainerSpec`) and the
 * PG15+ fresh-DB one-shot `initRealtimeJob` (`db-setup.ts`'s `legacyStartInitSchema15`, run by
 * BOTH `supabase start` and `db start`). Hoisted here (was defined directly in
 * `realtime.service.ts`, which still re-exports {@link LEGACY_REALTIME_TENANT_ID}/
 * {@link legacyBuildRealtimeEnv} for its own existing callers) once `db-setup.ts` itself moved
 * to `legacy/shared/` and needed this reachable across the `start`/`db` family boundary — see
 * `apps/cli/CLAUDE.md`'s "Hoist Before You Duplicate" rule.
 */

import type { ProjectConfig } from "@supabase/config";

import {
  LEGACY_START_INTERNAL_DB_NAME,
  LEGACY_START_INTERNAL_DB_PORT,
} from "./internal-db-connection.ts";

/**
 * Go's `utils.SUPERUSER_ROLE` (`apps/cli-go/internal/utils/connect.go:338`) —
 * Realtime's fixed `DB_USER` (`start.go:913`). Unrelated to the per-service
 * role each OTHER container's own DB connection string uses (PostgREST's
 * `authenticator`, Storage's `supabase_storage_admin`), so it is not hoisted
 * alongside `legacyStartInternalDbUrl`.
 */
const LEGACY_REALTIME_DB_USER = "supabase_admin";

/**
 * Go's `realtime.TenantId` default (`pkg/config/config.go:481`) — `toml:"-"`
 * (`config.go:254`), so never configurable via `config.toml` or a
 * `SUPABASE_*` override; always this literal. Exported: `kong.service.ts`'s
 * `kong.yml` template needs this exact same value for its `RealtimeId` field
 * (Go's `Config.Realtime.TenantId`, `start.go:492` — NOT Realtime's own
 * container name/id, see that module's `realtimeTenantId` doc comment).
 */
export const LEGACY_REALTIME_TENANT_ID = "realtime-dev";

/** Go's `realtime.EncryptionKey` default (`pkg/config/config.go:482`) — `toml:"-"`, never configurable. */
const LEGACY_REALTIME_ENCRYPTION_KEY = "supabaserealtime";

/** Go's `realtime.SecretKeyBase` default (`pkg/config/config.go:483`) — `toml:"-"`, never configurable. */
const LEGACY_REALTIME_SECRET_KEY_BASE =
  "EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG";

export interface LegacyRealtimeEnvInput {
  /** `config.realtime.ip_version` — feeds `utils.ToRealtimeEnv` (`utils/config.go:209-214`). */
  readonly ipVersion: ProjectConfig["realtime"]["ip_version"];
  /** `config.realtime.max_header_length`. */
  readonly maxHeaderLength: ProjectConfig["realtime"]["max_header_length"];
  /** The `db` container's own Docker name (`legacyServiceContainerName("db", projectId)`). */
  readonly dbHost: string;
  /** See {@link legacyStartInternalDbPassword}. */
  readonly dbPassword: string;
  /** `LegacyLocalConfigValues.jwtSecret` — feeds both `API_JWT_SECRET` and `METRICS_JWT_SECRET`. */
  readonly jwtSecret: string;
  /** `legacyResolveLocalJwks`'s resolved JWKS JSON string — feeds `API_JWT_JWKS`. */
  readonly jwks: string;
}

/**
 * Pure env-var builder, split out from `legacyBuildRealtimeContainerSpec`
 * so the full Go `Env` literal (`start.go:909-929`) is unit-testable without
 * constructing a whole container spec.
 */
export function legacyBuildRealtimeEnv(input: LegacyRealtimeEnvInput): Record<string, string> {
  return {
    PORT: "4000",
    DB_HOST: input.dbHost,
    DB_PORT: String(LEGACY_START_INTERNAL_DB_PORT),
    DB_USER: LEGACY_REALTIME_DB_USER,
    DB_PASSWORD: input.dbPassword,
    DB_NAME: LEGACY_START_INTERNAL_DB_NAME,
    DB_AFTER_CONNECT_QUERY: "SET search_path TO _realtime",
    DB_ENC_KEY: LEGACY_REALTIME_ENCRYPTION_KEY,
    API_JWT_SECRET: input.jwtSecret,
    API_JWT_JWKS: input.jwks,
    METRICS_JWT_SECRET: input.jwtSecret,
    APP_NAME: "realtime",
    SECRET_KEY_BASE: LEGACY_REALTIME_SECRET_KEY_BASE,
    ERL_AFLAGS: input.ipVersion === "IPv6" ? "-proto_dist inet6_tcp" : "-proto_dist inet_tcp",
    // Two literal single-quote characters, exactly like Go's `"DNS_NODES=''"` (`start.go:924`).
    DNS_NODES: "''",
    RLIMIT_NOFILE: "",
    SEED_SELF_HOST: "true",
    RUN_JANITOR: "true",
    MAX_HEADER_LENGTH: String(input.maxHeaderLength),
  };
}
