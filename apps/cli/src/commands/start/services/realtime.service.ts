/**
 * Builds the `docker create` spec for the Realtime container. Gated on `config.realtime.enabled`
 * by the caller, independent of PostgREST's `config.api.enabled`.
 */

import type { CliConfig } from "@supabase/config";

import { serviceContainerName } from "../../../command-internal/docker-ids.ts";
import {
  REALTIME_TENANT_ID,
  buildRealtimeEnv,
} from "../../../command-internal/db-bootstrap/realtime-env.ts";
import type { StartContainerSpec } from "../../../command-internal/db-bootstrap/docker-create-args.ts";
import { slimWgetHealthcheck } from "../../../command-internal/db-bootstrap/slim-runtime.ts";
import { usesSlimImageRuntime } from "../../../shared/services/slim-images.ts";
import { startInternalDbPassword } from "../../../command-internal/db-bootstrap/internal-db-connection.ts";

export interface RealtimeContainerSpecInput {
  /** The sanitized project id. */
  readonly projectId: string;
  /** `container.HostConfig.NetworkMode`'s target; resolved once per `start` run, not per-container. */
  readonly networkId: string;
  /** `config.realtime.image`, already resolved/pulled by the caller. */
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
    healthcheck: usesSlimImageRuntime(input.image)
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
    networkAliases: ["realtime", REALTIME_TENANT_ID],
    labels: {},
  };
}
