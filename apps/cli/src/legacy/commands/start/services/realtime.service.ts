/**
 * Port of Go's "Start Realtime" block
 * (`apps/cli-go/internal/start/start.go:903-958`).
 *
 * Enabled gate: `config.realtime.enabled` (`utils.Config.Realtime.Enabled`,
 * `start.go:904`) — independent of `config.api.enabled` (PostgREST's own
 * gate, `api.go:961`); the two are never conflated in Go. Gating (this field,
 * plus `!isContainerExcluded`) is the caller's responsibility — see
 * `start.services.ts`'s `realtime` catalog entry (`enabledGate:
 * "realtime.enabled"`) — this module only builds the container spec once
 * called.
 */

import type { ProjectConfig } from "@supabase/config";

import { legacyServiceContainerName } from "../../../shared/legacy-docker-ids.ts";
import type { LegacyStartContainerSpec } from "../lib/docker-create-args.ts";
import {
  legacyStartInternalDbPassword,
  LEGACY_START_INTERNAL_DB_NAME,
  LEGACY_START_INTERNAL_DB_PORT,
} from "../lib/internal-db-connection.ts";

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
 * Pure env-var builder, split out from {@link legacyBuildRealtimeContainerSpec}
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

export interface LegacyRealtimeContainerSpecInput {
  /** Go's `Config.ProjectId`, already sanitized — see `legacyServiceContainerName`'s callers. */
  readonly projectId: string;
  /** `container.HostConfig.NetworkMode`/`network.NetworkingConfig` target — the `--network-id` override or `utils.NetId`. */
  readonly networkId: string;
  /** `utils.Config.Realtime.Image`, already resolved/pulled by the caller (`image-prepull.ts`). */
  readonly image: string;
  readonly ipVersion: ProjectConfig["realtime"]["ip_version"];
  readonly maxHeaderLength: ProjectConfig["realtime"]["max_header_length"];
  /** `LegacyLocalConfigValues.dbUrl` — reused, not recomputed, to derive the internal DB password. */
  readonly dbUrl: string;
  readonly jwtSecret: string;
  readonly jwks: string;
}

/**
 * Builds the `docker create` spec for the Realtime container
 * (`start.go:903-958`). No `ports` (host-published) entry — Realtime, like
 * GoTrue, only ever `ExposedPorts` its port on the Docker network
 * (`nat.PortSet{"4000/tcp": {}}`, `start.go:930`).
 */
export function legacyBuildRealtimeContainerSpec(
  input: LegacyRealtimeContainerSpecInput,
): LegacyStartContainerSpec {
  const env = legacyBuildRealtimeEnv({
    ipVersion: input.ipVersion,
    maxHeaderLength: input.maxHeaderLength,
    dbHost: legacyServiceContainerName("db", input.projectId),
    dbPassword: legacyStartInternalDbPassword(input.dbUrl),
    jwtSecret: input.jwtSecret,
    jwks: input.jwks,
  });

  return {
    image: input.image,
    containerName: legacyServiceContainerName("realtime", input.projectId),
    env,
    binds: [],
    exposedPorts: [{ containerPort: "4000" }],
    healthcheck: {
      // Podman splits command by spaces unless quoted, but curl's header can't be quoted
      // (`start.go:932`, reproduced verbatim as this exec-form `test` array).
      test: [
        "CMD",
        "curl",
        "-sSfL",
        "--head",
        "-o",
        "/dev/null",
        "-H",
        `Host:${LEGACY_REALTIME_TENANT_ID}`,
        "http://127.0.0.1:4000/api/ping",
      ],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
    },
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    // `utils.RealtimeAliases = []string{"realtime", Config.Realtime.TenantId}` (`utils/config.go:40`).
    networkAliases: ["realtime", LEGACY_REALTIME_TENANT_ID],
    labels: {},
  };
}
