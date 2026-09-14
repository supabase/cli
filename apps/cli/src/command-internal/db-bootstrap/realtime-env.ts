/**
 * Realtime's environment variables, shared by the long-running Realtime container
 * (`buildRealtimeContainerSpec`) and the fresh-DB one-shot init job run by both
 * `supabase start` and `db start`.
 */

import type { CliConfig } from "@supabase/config";

import { START_INTERNAL_DB_NAME, START_INTERNAL_DB_PORT } from "./internal-db-connection.ts";

/** Realtime's fixed `DB_USER`; other containers connect under a different, per-service role. */
export const REALTIME_DB_USER = "supabase_admin";

/**
 * Fixed tenant id, never configurable. Also used by `kong.service.ts`'s `kong.yml` template
 * as `RealtimeId`.
 */
export const REALTIME_TENANT_ID = "realtime-dev";

/** Fixed default, never configurable. */
export const REALTIME_ENCRYPTION_KEY = "supabaserealtime";

/** Fixed default, never configurable. */
const REALTIME_SECRET_KEY_BASE = "EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG";

export interface RealtimeEnvInput {
  readonly ipVersion: CliConfig["realtime"]["ip_version"];
  readonly maxHeaderLength: CliConfig["realtime"]["max_header_length"];
  /** The `db` container's own Docker name. */
  readonly dbHost: string;
  /** See {@link startInternalDbPassword}. */
  readonly dbPassword: string;
  /** Feeds both `API_JWT_SECRET` and `METRICS_JWT_SECRET`. */
  readonly jwtSecret: string;
  /** The resolved JWKS JSON string; feeds `API_JWT_JWKS`. */
  readonly jwks: string;
}

export function buildRealtimeEnv(input: RealtimeEnvInput): Record<string, string> {
  return {
    PORT: "4000",
    DB_HOST: input.dbHost,
    DB_PORT: String(START_INTERNAL_DB_PORT),
    DB_USER: REALTIME_DB_USER,
    DB_PASSWORD: input.dbPassword,
    DB_NAME: START_INTERNAL_DB_NAME,
    DB_AFTER_CONNECT_QUERY: "SET search_path TO _realtime",
    DB_ENC_KEY: REALTIME_ENCRYPTION_KEY,
    API_JWT_SECRET: input.jwtSecret,
    API_JWT_JWKS: input.jwks,
    METRICS_JWT_SECRET: input.jwtSecret,
    APP_NAME: "realtime",
    SECRET_KEY_BASE: REALTIME_SECRET_KEY_BASE,
    ERL_AFLAGS: input.ipVersion === "IPv6" ? "-proto_dist inet6_tcp" : "-proto_dist inet_tcp",
    // Two literal single-quote characters, not an empty string.
    DNS_NODES: "''",
    RLIMIT_NOFILE: "",
    SEED_SELF_HOST: "true",
    RUN_JANITOR: "true",
    MAX_HEADER_LENGTH: String(input.maxHeaderLength),
  };
}
