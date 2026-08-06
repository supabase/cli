/**
 * Port of Go's "Start Mailpit" block (`apps/cli-go/internal/start/start.go:
 * 853-901`), gated on `config.inbucket.enabled` (`utils.Config.Inbucket.Enabled`
 * in Go) — the gate itself is `start.handler.ts`'s job (a later task), not
 * this module's; this file only builds the `docker create` spec.
 *
 * The simplest of the container-bring-up services in this port: no hostname
 * override, no entrypoint/cmd override, no binds, and exactly one
 * unconditional env var. The only real branching is which of the two optional
 * ports (SMTP, POP3) get published alongside the always-on web UI port.
 */

import { legacyServiceContainerName } from "../../../shared/legacy-docker-ids.ts";
import type { LegacyStartContainerSpec } from "../../../shared/db-bootstrap/docker-create-args.ts";

/**
 * `utils.InbucketAliases[0]` (`apps/cli-go/internal/utils/config.go:39`) — also
 * this service's `containerSuffix` in `LEGACY_SERVICE_CATALOG`
 * (`legacy-service-catalog.ts`). Mailpit keeps the Go-internal "inbucket" name
 * (the product it replaced) for the container/alias/id, even though the
 * user-facing service and config section are "Mailpit"/`config.inbucket`.
 */
const LEGACY_MAILPIT_CONTAINER_SUFFIX = "inbucket";

export interface LegacyMailpitContainerSpecInput {
  /**
   * `container.Config.Image` — the already-resolved `config.inbucket.image`.
   * Not part of the decoded `@supabase/config` schema (Go's own
   * `Inbucket.Image` field is `toml:"-"`); resolution is the caller's
   * responsibility, same as every other service in this port.
   */
  readonly image: string;
  /** Go's `Config.ProjectId`, used to derive `utils.InbucketId` via {@link legacyServiceContainerName}. */
  readonly projectId: string;
  /**
   * `container.HostConfig.NetworkMode`'s target — resolved once per `start`
   * run, not per-container (see `LegacyStartContainerSpec.networkId`'s doc
   * comment in `docker-create-args.ts`).
   */
  readonly networkId: string;
  /** `config.inbucket.port` — always published as `8025/tcp` (`start.go:855-857`). */
  readonly port: number;
  /**
   * `config.inbucket.smtp_port` — published as `1025/tcp` only when set and
   * non-zero, matching Go's `SmtpPort != 0` guard (`start.go:858-862`).
   * `@supabase/config` has no default for this key, so an absent value
   * decodes to `undefined` — the same "unset" case as Go's zero `uint16`.
   */
  readonly smtpPort?: number;
  /**
   * `config.inbucket.pop3_port` — published as `1110/tcp` only when set and
   * non-zero, matching Go's `Pop3Port != 0` guard (`start.go:863-867`).
   */
  readonly pop3Port?: number;
}

/** Builds the `docker create` spec for the Mailpit/Inbucket container (`start.go:853-901`). */
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
      // Disable reverse DNS lookups in Mailpit to avoid slow/delayed DNS resolution (start.go:873-874).
      MP_SMTP_DISABLE_RDNS: "true",
    },
    binds: [],
    ports,
    healthcheck: {
      test: ["CMD", "/mailpit", "readyz"],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
      // StartPeriod taken from upstream Dockerfile (start.go:881-882).
      startPeriodSeconds: 10,
    },
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    networkAliases: [LEGACY_MAILPIT_CONTAINER_SUFFIX],
    labels: {},
  };
}
