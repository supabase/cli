/**
 * Port of Go's "Start PostgREST" block
 * (`apps/cli-go/internal/start/start.go:960-992`).
 *
 * Enabled gate: `config.api.enabled` (`utils.Config.Api.Enabled`,
 * `start.go:961`). Gating (this field, plus `!isContainerExcluded`) is the
 * caller's responsibility — see `start.services.ts`'s `postgrest` catalog
 * entry (`enabledGate: "api.enabled"`).
 *
 * No `Healthcheck` field at all: Go's own `container.Config` literal for this
 * service (`start.go:964-976`) sets only `Image`/`Env`, with the comment
 * `// PostgREST does not expose a shell for health check` in place of a
 * `Healthcheck:` entry — confirmed by reading the struct literal itself, not
 * just the comment. PostgREST readiness is instead checked at runtime via an
 * HTTP HEAD through the local Kong gateway
 * (`legacyCheckHttpReady`/`LEGACY_POSTGREST_READY_PATH`, `../lib/health-check.ts`,
 * itself porting `status.go:159-229`'s "PostgREST does not support native
 * health checks" branch) — this builder correctly omits `healthcheck` so
 * `legacyBuildStartContainerCreateArgs` never emits a `--health-*` flag for
 * this container, matching `docker-create-args.ts`'s own documented
 * PostgREST exception.
 */

import type { ProjectConfig } from "@supabase/config";

import { legacyServiceContainerName } from "../../../shared/legacy-docker-ids.ts";
import type { LegacyStartContainerSpec } from "../lib/docker-create-args.ts";
import {
  legacyStartInternalDbPassword,
  legacyStartInternalDbUrl,
} from "../lib/internal-db-connection.ts";

export interface LegacyPostgrestEnvInput {
  /** `config.api.schemas` — joined with `,` into `PGRST_DB_SCHEMAS`. */
  readonly schemas: ProjectConfig["api"]["schemas"];
  /** `config.api.extra_search_path` — joined with `,` into `PGRST_DB_EXTRA_SEARCH_PATH`. */
  readonly extraSearchPath: ProjectConfig["api"]["extra_search_path"];
  /** `config.api.max_rows`. */
  readonly maxRows: ProjectConfig["api"]["max_rows"];
  /** The `db` container's own Docker name (`legacyServiceContainerName("db", projectId)`). */
  readonly dbHost: string;
  /** See `legacyStartInternalDbPassword` (`../lib/internal-db-connection.ts`). */
  readonly dbPassword: string;
  /**
   * `legacyResolveLocalJwks`'s resolved JWKS JSON string — feeds
   * `PGRST_JWT_SECRET` directly (Go's `fmt.Sprintf("PGRST_JWT_SECRET=%s",
   * jwks)`, `start.go:972`; despite the env var's name, PostgREST is fed the
   * JWKS document, not the raw `auth.jwt_secret`).
   */
  readonly jwks: string;
}

/**
 * Pure env-var builder, split out from
 * {@link legacyBuildPostgrestContainerSpec} so the full Go `Env` literal
 * (`start.go:966-973`) is unit-testable without constructing a whole
 * container spec.
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
  /** Go's `Config.ProjectId`, already sanitized — see `legacyServiceContainerName`'s callers. */
  readonly projectId: string;
  /** `container.HostConfig.NetworkMode`/`network.NetworkingConfig` target — the `--network-id` override or `utils.NetId`. */
  readonly networkId: string;
  /** `utils.Config.Api.Image`, already resolved/pulled by the caller (`image-prepull.ts`). */
  readonly image: string;
  readonly schemas: ProjectConfig["api"]["schemas"];
  readonly extraSearchPath: ProjectConfig["api"]["extra_search_path"];
  readonly maxRows: ProjectConfig["api"]["max_rows"];
  /** `LegacyLocalConfigValues.dbUrl` — reused, not recomputed, to derive the internal DB password. */
  readonly dbUrl: string;
  readonly jwks: string;
}

/**
 * Builds the `docker create` spec for the PostgREST container
 * (`start.go:960-992`). No `ports`/`exposedPorts` either — Go's
 * `container.Config` literal for this service declares neither.
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
    // `utils.RestAliases = []string{"rest"}` (`utils/config.go:41`).
    networkAliases: ["rest"],
    labels: {},
  };
}
