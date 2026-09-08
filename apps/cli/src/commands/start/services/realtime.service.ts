/**
 * Builds the Realtime container spec.
 *
 * Enabled gate: `config.realtime.enabled` — independent of
 * `config.api.enabled` (PostgREST's own gate); the two are never conflated.
 * Gating (this field, plus `!isContainerExcluded`) is the caller's
 * responsibility — see `start.services.ts`'s `realtime` catalog entry
 * (`enabledGate: "realtime.enabled"`) — this module only builds the
 * container spec once called.
 */

import type { CliConfig } from "@supabase/config";

import { serviceContainerName } from "../../../command-internal/docker-ids.ts";
import {
  REALTIME_TENANT_ID,
  buildRealtimeEnv,
} from "../../../command-internal/db-bootstrap/realtime-env.ts";
import type { StartContainerSpec } from "../../../command-internal/db-bootstrap/docker-create-args.ts";
import {
  slimWgetHealthcheck,
  usesSlimRuntime,
} from "../../../command-internal/db-bootstrap/slim-runtime.ts";
import { startInternalDbPassword } from "../../../command-internal/db-bootstrap/internal-db-connection.ts";

export interface RealtimeContainerSpecInput {
  /** The sanitized project id — see `serviceContainerName`'s callers. */
  readonly projectId: string;
  /** `container.HostConfig.NetworkMode`/`network.NetworkingConfig` target — the `--network-id` override or `utils.NetId`. */
  readonly networkId: string;
  /** `utils.Config.Realtime.Image`, already resolved/pulled by the caller (`image-prepull.ts`). */
  readonly image: string;
  readonly ipVersion: CliConfig["realtime"]["ip_version"];
  readonly maxHeaderLength: CliConfig["realtime"]["max_header_length"];
  /** `LocalConfigValues.dbUrl` — reused, not recomputed, to derive the internal DB password. */
  readonly dbUrl: string;
  readonly jwtSecret: string;
  readonly jwks: string;
}

/**
 * Builds the `docker create` spec for the Realtime container. No `ports`
 * (host-published) entry — Realtime, like GoTrue, only ever exposes its port
 * on the Docker network.
 */
export function buildRealtimeContainerSpec(input: RealtimeContainerSpecInput): StartContainerSpec {
  const env = buildRealtimeEnv({
    ipVersion: input.ipVersion,
    maxHeaderLength: input.maxHeaderLength,
    dbHost: serviceContainerName("db", input.projectId),
    dbPassword: startInternalDbPassword(input.dbUrl),
    jwtSecret: input.jwtSecret,
    jwks: input.jwks,
  });

  return {
    image: input.image,
    containerName: serviceContainerName("realtime", input.projectId),
    env,
    binds: [],
    exposedPorts: [{ containerPort: "4000" }],
    healthcheck: usesSlimRuntime(input.image)
      ? slimWgetHealthcheck("http://127.0.0.1:4000/api/ping", {
          header: `Host:${REALTIME_TENANT_ID}`,
        })
      : {
          // Podman splits command by spaces unless quoted, but curl's header can't be
          // quoted, hence this exec-form `test` array.
          test: [
            "CMD",
            "curl",
            "-sSfL",
            "--head",
            "-o",
            "/dev/null",
            "-H",
            `Host:${REALTIME_TENANT_ID}`,
            "http://127.0.0.1:4000/api/ping",
          ],
          intervalSeconds: 10,
          timeoutSeconds: 2,
          retries: 3,
        },
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    // Network aliases: `realtime` plus the tenant id.
    networkAliases: ["realtime", REALTIME_TENANT_ID],
    labels: {},
  };
}
