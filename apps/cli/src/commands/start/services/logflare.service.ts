/**
 * Builds the `docker create` spec for the Logflare/analytics container. Gating on
 * `config.analytics.enabled` is the caller's responsibility.
 *
 * Writes and execs its own `run.sh` because the image's own entrypoint conflicts with the
 * healthcheck due to a 15-second startup sleep
 * (https://github.com/Logflare/logflare/blob/staging/run.sh#L35). Branches on
 * `config.analytics.backend` (`postgres` vs `bigquery`) for env vars and, for BigQuery, a bind
 * mount for the GCP service-account JSON.
 */

import { join } from "node:path";

import { serviceContainerName } from "../../../command-internal/docker-ids.ts";
import type { StartContainerSpec } from "../../../command-internal/db-bootstrap/docker-create-args.ts";
import { slimWgetHealthcheck } from "../../../command-internal/db-bootstrap/slim-runtime.ts";
import { usesSlimImageRuntime } from "../../../shared/services/slim-images.ts";

/** The Logflare network alias — also this service's `containerSuffix` in `SERVICE_CATALOG`. */
const LOGFLARE_CONTAINER_SUFFIX = "analytics";

/**
 * The DB user Logflare's own Ecto connection authenticates as, distinct from
 * {@link LogflareContainerSpecInput.dbUser} (used only for the Postgres-backend
 * `POSTGRES_BACKEND_URL`).
 */
const LOGFLARE_DB_USERNAME = "supabase_admin";

/** The analytics API key's only possible value; never decoded from `config.toml`, so it's hardcoded rather than threaded through as an input. */
const LOGFLARE_API_KEY = "api-key";

/**
 * Writes and execs a custom `run.sh`: the image's own entrypoint conflicts with the container
 * healthcheck due to a 15-second startup sleep. Runs `migrate && start` so a failed migration
 * exits the container and the restart policy retries until the db is ready, instead of running
 * Logflare against an unmigrated database. Stays PID 1, trapping TERM to forward it, wait 3s,
 * then KILL — a plain `exec` of `beam.smp` was still hitting Docker's 10s SIGTERM grace.
 */
const LOGFLARE_ENTRYPOINT_SCRIPT =
  "cat <<'EOF' > run.sh && exec sh run.sh\n" +
  "./logflare eval Logflare.Release.migrate || exit $?\n" +
  "./logflare start --sname logflare &\n" +
  "BEAM_PID=$!\n" +
  'trap \'kill -TERM "$BEAM_PID" 2>/dev/null; n=0; while [ "$n" -lt 3 ] && kill -0 "$BEAM_PID" 2>/dev/null; do n=$((n+1)); sleep 1; done; kill -KILL "$BEAM_PID" 2>/dev/null\' TERM\n' +
  'wait "$BEAM_PID"\n' +
  "code=$?\n" +
  'if [ "$code" -gt 128 ]; then wait "$BEAM_PID" 2>/dev/null; code2=$?; [ "$code2" -ne 127 ] && code=$code2; fi\n' +
  'exit "$code"\n' +
  "EOF\n";

export interface LogflareContainerSpecInput {
  /**
   * The already-resolved `config.analytics.image`. Not part of the decoded
   * `@supabase/config` schema; resolution is the caller's responsibility.
   */
  readonly image: string;
  /** The project id, used to derive this container's own name via {@link serviceContainerName}. */
  readonly projectId: string;
  /** `container.HostConfig.NetworkMode`'s target — resolved once per `start` run, not per-container. */
  readonly networkId: string;
  /** `config.analytics.port` — published as `4000/tcp`. */
  readonly port: number;
  /** `config.analytics.backend`. */
  readonly backend: "postgres" | "bigquery";
  /** `config.analytics.gcp_project_id` — only read when {@link backend} is `"bigquery"`. */
  readonly gcpProjectId: string;
  /** `config.analytics.gcp_project_number` — only read when {@link backend} is `"bigquery"`. */
  readonly gcpProjectNumber: string;
  /**
   * `config.analytics.gcp_jwt_path`, only read when {@link backend} is `"bigquery"`. Always
   * joined onto {@link workdir}; an unset field falls back to a bind mount of `workdir` itself.
   */
  readonly gcpJwtPath: string;
  /** The process working directory, used to resolve {@link gcpJwtPath} to a host path. */
  readonly workdir: string;
  /** The `db` container's own hostname. */
  readonly dbHost: string;
  /** Hardcoded `5432`. */
  readonly dbPort: number;
  /**
   * Hardcoded `"postgres"`, used only for the Postgres-backend `POSTGRES_BACKEND_URL` env var —
   * not for `DB_USERNAME` (see {@link LOGFLARE_DB_USERNAME}).
   */
  readonly dbUser: string;
  /** `config.db.password`. */
  readonly dbPassword: string;
}

/** Builds the `docker create` spec for the Logflare/analytics container. */
export function buildLogflareContainerSpec(input: LogflareContainerSpecInput): StartContainerSpec {
  const env: Record<string, string> = {
    DB_DATABASE: "_supabase",
    DB_HOSTNAME: input.dbHost,
    DB_PORT: String(input.dbPort),
    DB_SCHEMA: "_analytics",
    DB_USERNAME: LOGFLARE_DB_USERNAME,
    DB_PASSWORD: input.dbPassword,
    LOGFLARE_MIN_CLUSTER_SIZE: "1",
    LOGFLARE_SINGLE_TENANT: "true",
    LOGFLARE_SUPABASE_MODE: "true",
    LOGFLARE_PRIVATE_ACCESS_TOKEN: LOGFLARE_API_KEY,
    LOGFLARE_LOG_LEVEL: "warn",
    LOGFLARE_NODE_HOST: "127.0.0.1",
    // The single quotes are part of the literal value; this is set directly on the container
    // env, not through a shell, so they are never stripped.
    LOGFLARE_FEATURE_FLAG_OVERRIDE: "'multibackend=true'",
    RELEASE_COOKIE: "cookie",
  };

  const binds: Array<string> = [];
  const slim = usesSlimImageRuntime(input.image);

  if (input.backend === "bigquery") {
    const hostJwtPath = join(input.workdir, input.gcpJwtPath);
    binds.push(`${hostJwtPath}:/opt/app/rel/logflare/bin/gcloud.json`);
    env.GOOGLE_DATASET_ID_APPEND = "_prod";
    env.GOOGLE_PROJECT_ID = input.gcpProjectId;
    env.GOOGLE_PROJECT_NUMBER = input.gcpProjectNumber;
  } else {
    env.POSTGRES_BACKEND_URL = `postgresql://${input.dbUser}:${input.dbPassword}@${input.dbHost}:${input.dbPort}/_supabase`;
    env.POSTGRES_BACKEND_SCHEMA = "_analytics";
  }

  return {
    image: input.image,
    containerName: serviceContainerName(LOGFLARE_CONTAINER_SUFFIX, input.projectId),
    hostname: "127.0.0.1",
    env,
    entrypoint: "sh",
    cmd: ["-c", LOGFLARE_ENTRYPOINT_SCRIPT],
    binds,
    exposedPorts: [{ containerPort: "4000" }],
    ports: [{ hostPort: String(input.port), containerPort: "4000" }],
    healthcheck: slim
      ? slimWgetHealthcheck("http://127.0.0.1:4000/health", {
          startPeriodSeconds: 10,
        })
      : {
          test: [
            "CMD",
            "curl",
            "-sSfL",
            "--head",
            "-o",
            "/dev/null",
            "http://127.0.0.1:4000/health",
          ],
          intervalSeconds: 10,
          timeoutSeconds: 2,
          retries: 3,
          startPeriodSeconds: 10,
        },
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    networkAliases: [LOGFLARE_CONTAINER_SUFFIX],
    labels: {},
  };
}
