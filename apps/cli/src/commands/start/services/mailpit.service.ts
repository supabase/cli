import { serviceContainerName } from "../../../command-internal/docker-ids.ts";
import type { StartContainerSpec } from "../../../command-internal/db-bootstrap/docker-create-args.ts";

/**
 * This service's `containerSuffix` in `SERVICE_CATALOG`. Kept as "inbucket" (the product Mailpit
 * replaced) even though the user-facing service and config section are "Mailpit"/`config.inbucket`.
 */
const MAILPIT_CONTAINER_SUFFIX = "inbucket";

export interface MailpitContainerSpecInput {
  /** The already-resolved `config.inbucket.image`; resolution is the caller's responsibility. */
  readonly image: string;
  /** The project id, used to derive this container's own name via {@link serviceContainerName}. */
  readonly projectId: string;
  /** `container.HostConfig.NetworkMode`'s target; resolved once per `start` run, not per-container. */
  readonly networkId: string;
  /** `config.inbucket.port` — always published as `8025/tcp`. */
  readonly port: number;
  /** `config.inbucket.smtp_port`; published as `1025/tcp` only when set (not `undefined`) and non-zero. */
  readonly smtpPort?: number;
  /** `config.inbucket.pop3_port`; published as `1110/tcp` only when set (not `undefined`) and non-zero. */
  readonly pop3Port?: number;
}

/** Builds the `docker create` spec for the Mailpit/Inbucket container. */
export function buildMailpitContainerSpec(input: MailpitContainerSpecInput): StartContainerSpec {
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
    containerName: serviceContainerName(MAILPIT_CONTAINER_SUFFIX, input.projectId),
    env: {
      // Disables reverse DNS lookups to avoid slow/delayed DNS resolution.
      MP_SMTP_DISABLE_RDNS: "true",
    },
    binds: [],
    ports,
    healthcheck: {
      test: ["CMD", "/mailpit", "readyz"],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
      // Matches Mailpit's own upstream healthcheck start period.
      startPeriodSeconds: 10,
    },
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    networkAliases: [MAILPIT_CONTAINER_SUFFIX],
    labels: {},
  };
}
