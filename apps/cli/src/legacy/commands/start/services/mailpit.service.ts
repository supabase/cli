/**
 * Mailpit container spec builder, gated on `config.inbucket.enabled` — the
 * gate itself is `start.handler.ts`'s job (a later task), not this module's;
 * this file only builds the `docker create` spec.
 *
 * The simplest of the container-bring-up services in this port: no hostname
 * override, no entrypoint/cmd override, no binds, and exactly one
 * unconditional env var. The only real branching is which of the two optional
 * ports (SMTP, POP3) get published alongside the always-on web UI port.
 */

import { legacyServiceContainerName } from "../../../shared/legacy-docker-ids.ts";
import type { LegacyStartContainerSpec } from "../../../shared/db-bootstrap/docker-create-args.ts";

/**
 * Also this service's `containerSuffix` in `LEGACY_SERVICE_CATALOG`
 * (`legacy-service-catalog.ts`). Mailpit keeps the internal "inbucket" name
 * (the product it replaced) for the container/alias/id, even though the
 * user-facing service and config section are "Mailpit"/`config.inbucket`.
 */
const LEGACY_MAILPIT_CONTAINER_SUFFIX = "inbucket";

export interface LegacyMailpitContainerSpecInput {
  /**
   * The already-resolved `config.inbucket.image`. Not part of the decoded
   * `@supabase/config` schema; resolution is the caller's responsibility,
   * same as every other service in this port.
   */
  readonly image: string;
  /** The project id, used to derive this container's own name via {@link legacyServiceContainerName}. */
  readonly projectId: string;
  /**
   * `container.HostConfig.NetworkMode`'s target — resolved once per `start`
   * run, not per-container (see `LegacyStartContainerSpec.networkId`'s doc
   * comment in `docker-create-args.ts`).
   */
  readonly networkId: string;
  /** `config.inbucket.port` — always published as `8025/tcp`. */
  readonly port: number;
  /**
   * `config.inbucket.smtp_port` — published as `1025/tcp` only when set and
   * non-zero. `@supabase/config` has no default for this key, so an absent
   * value decodes to `undefined` — the "unset" case.
   */
  readonly smtpPort?: number;
  /**
   * `config.inbucket.pop3_port` — published as `1110/tcp` only when set and
   * non-zero.
   */
  readonly pop3Port?: number;
}

/** Builds the `docker create` spec for the Mailpit/Inbucket container. */
export function legacyBuildMailpitContainerSpec(
  input: LegacyMailpitContainerSpecInput,
): LegacyStartContainerSpec {
  const ports: Array<{ hostPort: string; containerPort: string }> = [
    { hostPort: String(input.port), containerPort: "8025" },
  ];
  if (input.smtpPort !== undefined && input.smtpPort !== 0) {
    ports.push({ hostPort: String(input.smtpPort), containerPort: "1025" });
  }
  if (input.pop3Port !== undefined && input.pop3Port !== 0) {
    ports.push({ hostPort: String(input.pop3Port), containerPort: "1110" });
  }

  return {
    image: input.image,
    containerName: legacyServiceContainerName(LEGACY_MAILPIT_CONTAINER_SUFFIX, input.projectId),
    env: {
      // Disable reverse DNS lookups in Mailpit to avoid slow/delayed DNS resolution.
      MP_SMTP_DISABLE_RDNS: "true",
    },
    binds: [],
    ports,
    healthcheck: {
      test: ["CMD", "/mailpit", "readyz"],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
      // StartPeriod taken from upstream Dockerfile.
      startPeriodSeconds: 10,
    },
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    networkAliases: [LEGACY_MAILPIT_CONTAINER_SUFFIX],
    labels: {},
  };
}
