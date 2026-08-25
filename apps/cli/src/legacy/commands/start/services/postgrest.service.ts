/**
 * PostgREST container spec builder.
 *
 * Enabled gate: `config.api.enabled`. Gating (this field, plus
 * `!isContainerExcluded`) is the caller's responsibility — see
 * `start.services.ts`'s `postgrest` catalog entry (`enabledGate:
 * "api.enabled"`).
 *
 * No `Healthcheck` field at all: PostgREST does not expose a shell for
 * health checks. PostgREST readiness is instead checked at runtime via an
 * HTTP HEAD through the local Kong gateway
 * (`legacyCheckHttpReady`/`LEGACY_POSTGREST_READY_PATH`,
 * `../../../shared/db-bootstrap/health-check.ts`) — this builder correctly
 * omits `healthcheck` so `legacyBuildStartContainerCreateArgs` never emits a
 * `--health-*` flag for this container, matching `docker-create-args.ts`'s
 * own documented PostgREST exception.
 */

import type { CliConfig } from "@supabase/config";

import { legacyServiceContainerName } from "../../../shared/legacy-docker-ids.ts";
import type { LegacyStartContainerSpec } from "../../../shared/db-bootstrap/docker-create-args.ts";
import {
  legacyStartInternalDbPassword,
  legacyStartInternalDbUrl,
} from "../../../shared/db-bootstrap/internal-db-connection.ts";

export interface LegacyPostgrestEnvInput {
  /** `config.api.schemas` — joined with `,` into `PGRST_DB_SCHEMAS`. */
  readonly schemas: CliConfig["api"]["schemas"];
  /** `config.api.extra_search_path` — joined with `,` into `PGRST_DB_EXTRA_SEARCH_PATH`. */
  readonly extraSearchPath: CliConfig["api"]["extra_search_path"];
  /** `config.api.max_rows`. */
  readonly maxRows: CliConfig["api"]["max_rows"];
  /** The `db` container's own Docker name (`legacyServiceContainerName("db", projectId)`). */
  readonly dbHost: string;
  /** See `legacyStartInternalDbPassword` (`../../../shared/db-bootstrap/internal-db-connection.ts`). */
  readonly dbPassword: string;
  /**
   * `legacyResolveLocalJwks`'s resolved JWKS JSON string — feeds
   * `PGRST_JWT_SECRET` directly (despite the env var's name, PostgREST is
   * fed the JWKS document, not the raw `auth.jwt_secret`).
   */
  readonly jwks: string;
}

/**
 * Pure env-var builder, split out from
 * {@link legacyBuildPostgrestContainerSpec} so the full env set is
 * unit-testable without constructing a whole container spec.
 */
export function legacyBuildPostgrestEnv(input: LegacyPostgrestEnvInput): Record<string, string> {
  return {
    PGRST_DB_URI: legacyStartInternalDbUrl("authenticator", input.dbHost, input.dbPassword),
    PGRST_DB_SCHEMAS: input.schemas.join(","),
    PGRST_DB_EXTRA_SEARCH_PATH: input.extraSearchPath.join(","),
    PGRST_DB_MAX_ROWS: String(input.maxRows),
    PGRST_DB_ANON_ROLE: "anon",
    PGRST_JWT_SECRET: input.jwks,
    PGRST_ADMIN_SERVER_PORT: "3001",
  };
}

export interface LegacyPostgrestContainerSpecInput {
  /** The sanitized project id — see `legacyServiceContainerName`'s callers. */
  readonly projectId: string;
  /** `container.HostConfig.NetworkMode`/`network.NetworkingConfig` target — the `--network-id` override or `utils.NetId`. */
  readonly networkId: string;
  /** `utils.Config.Api.Image`, already resolved/pulled by the caller (`image-prepull.ts`). */
  readonly image: string;
  readonly schemas: CliConfig["api"]["schemas"];
  readonly extraSearchPath: CliConfig["api"]["extra_search_path"];
  readonly maxRows: CliConfig["api"]["max_rows"];
  /** `LegacyLocalConfigValues.dbUrl` — reused, not recomputed, to derive the internal DB password. */
  readonly dbUrl: string;
  readonly jwks: string;
}

/**
 * Builds the `docker create` spec for the PostgREST container. No
 * `ports`/`exposedPorts` either.
 */
export function legacyBuildPostgrestContainerSpec(
  input: LegacyPostgrestContainerSpecInput,
): LegacyStartContainerSpec {
  const env = legacyBuildPostgrestEnv({
    schemas: input.schemas,
    extraSearchPath: input.extraSearchPath,
    maxRows: input.maxRows,
    dbHost: legacyServiceContainerName("db", input.projectId),
    dbPassword: legacyStartInternalDbPassword(input.dbUrl),
    jwks: input.jwks,
  });

  return {
    image: input.image,
    containerName: legacyServiceContainerName("rest", input.projectId),
    env,
    binds: [],
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    // The PostgREST network alias.
    networkAliases: ["rest"],
    labels: {},
  };
}
