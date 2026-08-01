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
import {
  LEGACY_REALTIME_TENANT_ID,
  legacyBuildRealtimeEnv,
} from "../../../shared/db-bootstrap/realtime-env.ts";
import type { LegacyStartContainerSpec } from "../../../shared/containers/docker-create-args.ts";
import { legacyStartInternalDbPassword } from "../../../shared/db-bootstrap/internal-db-connection.ts";

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
