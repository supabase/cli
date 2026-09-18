/**
 * Builds the `docker create` spec for the PostgREST container. Gated on `config.api.enabled` by
 * the caller.
 *
 * Omits `healthcheck`: PostgREST has no shell to run a Docker health check command, so its
 * readiness is checked at runtime via an HTTP HEAD through the local Kong gateway instead
 * (`checkHttpReady`/`POSTGREST_READY_PATH`).
 */

import type { CliConfig } from "@supabase/config";

import { serviceContainerName } from "../../../command-internal/docker-ids.ts";
import type { StartContainerSpec } from "../../../command-internal/db-bootstrap/docker-create-args.ts";
import {
  startInternalDbPassword,
  startInternalDbUrl,
} from "../../../command-internal/db-bootstrap/internal-db-connection.ts";

export interface PostgrestEnvInput {
  /** `config.api.schemas` — joined with `,` into `PGRST_DB_SCHEMAS`. */
  readonly schemas: CliConfig["api"]["schemas"];
  /** `config.api.extra_search_path` — joined with `,` into `PGRST_DB_EXTRA_SEARCH_PATH`. */
  readonly extraSearchPath: CliConfig["api"]["extra_search_path"];
  /** `config.api.max_rows`. */
  readonly maxRows: CliConfig["api"]["max_rows"];
  /** The `db` container's own Docker name (`serviceContainerName("db", projectId)`). */
  readonly dbHost: string;
  /** See {@link startInternalDbPassword}. */
  readonly dbPassword: string;
  /**
   * The resolved JWKS JSON string, fed into `PGRST_JWT_SECRET` — despite the name, PostgREST
   * receives the JWKS document, not the raw `auth.jwt_secret`.
   */
  readonly jwks: string;
}

/** Builds the env vars for the PostgREST container. */
export function buildPostgrestEnv(input: PostgrestEnvInput): Record<string, string> {
  return {
    PGRST_DB_URI: startInternalDbUrl("authenticator", input.dbHost, input.dbPassword),
    PGRST_DB_SCHEMAS: input.schemas.join(","),
    PGRST_DB_EXTRA_SEARCH_PATH: input.extraSearchPath.join(","),
    PGRST_DB_MAX_ROWS: String(input.maxRows),
    PGRST_DB_ANON_ROLE: "anon",
    PGRST_JWT_SECRET: input.jwks,
    PGRST_ADMIN_SERVER_PORT: "3001",
  };
}

export interface PostgrestContainerSpecInput {
  /** The sanitized project id. */
  readonly projectId: string;
  /** `container.HostConfig.NetworkMode`'s target; resolved once per `start` run, not per-container. */
  readonly networkId: string;
  /** `config.api.image`, already resolved/pulled by the caller. */
  readonly image: string;
  readonly schemas: CliConfig["api"]["schemas"];
  readonly extraSearchPath: CliConfig["api"]["extra_search_path"];
  readonly maxRows: CliConfig["api"]["max_rows"];
  /** `LocalConfigValues.dbUrl` — reused, not recomputed, to derive the internal DB password. */
  readonly dbUrl: string;
  readonly jwks: string;
}

/**
 * Builds the `docker create` spec for the PostgREST container. No
 * `ports`/`exposedPorts` either.
 */
export function buildPostgrestContainerSpec(
  input: PostgrestContainerSpecInput,
): StartContainerSpec {
  const env = buildPostgrestEnv({
    schemas: input.schemas,
    extraSearchPath: input.extraSearchPath,
    maxRows: input.maxRows,
    dbHost: serviceContainerName("db", input.projectId),
    dbPassword: startInternalDbPassword(input.dbUrl),
    jwks: input.jwks,
  });

  return {
    image: input.image,
    containerName: serviceContainerName("rest", input.projectId),
    env,
    binds: [],
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    networkAliases: ["rest"],
    labels: {},
  };
}
