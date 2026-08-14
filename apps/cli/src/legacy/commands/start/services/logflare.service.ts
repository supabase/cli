/**
 * Logflare container spec builder, gated on `config.analytics.enabled` — the
 * gate itself is `start.handler.ts`'s job (a later task), not this module's;
 * this file only builds the `docker create` spec.
 *
 * Two things make this the fullest worked example among the three real
 * services ported in this file group:
 *
 * - A custom `Entrypoint`/`Cmd` pair that writes and runs its own `run.sh`,
 *   because the image's own entrypoint conflicts with the healthcheck due to
 *   a 15-second sleep
 *   (https://github.com/Logflare/logflare/blob/staging/run.sh#L35).
 * - A `config.analytics.backend` branch (`postgres` vs `bigquery`) that
 *   appends different env vars (and, for BigQuery only, a bind mount for the
 *   GCP service-account JSON).
 */

import { join } from "node:path";

import { legacyServiceContainerName } from "../../../shared/legacy-docker-ids.ts";
import type { LegacyStartContainerSpec } from "../../../shared/db-bootstrap/docker-create-args.ts";

/** The Logflare network alias — also this service's `containerSuffix` in `LEGACY_SERVICE_CATALOG`. */
const LEGACY_LOGFLARE_CONTAINER_SUFFIX = "analytics";

/**
 * The superuser role — the DB user Logflare's own Ecto connection
 * authenticates as. Distinct from
 * {@link LegacyLogflareContainerSpecInput.dbUser} (`"postgres"`), which is
 * used only for the Postgres-backend `POSTGRES_BACKEND_URL` below — two
 * different DB users really are used for two different env vars in this one
 * block.
 */
const LEGACY_LOGFLARE_DB_USERNAME = "supabase_admin";

/**
 * The analytics API key's only possible value. It's never decoded from
 * `config.toml`, so this can never actually vary; hardcoding it here
 * (rather than threading it through as an input) reflects that.
 */
const LEGACY_LOGFLARE_API_KEY = "api-key";

/**
 * The Logflare entrypoint script: the image's own entrypoint conflicts with
 * the container healthcheck due to a 15-second sleep, so this writes its own
 * `run.sh` and runs that instead.
 *
 * Deliberate design choice, do not "fix" this in a later cleanup (issue
 * #6088): `migrate && start`, so a failed migrate exits the container and
 * the `unless-stopped` restart policy retries until the db is ready —
 * running Logflare against an unmigrated database lets Oban die on the
 * missing `public.oban_jobs` table instead.
 */
// Both `exec`s route `docker stop`'s SIGTERM to Logflare's BEAM as PID 1 (`exec sh run.sh`
// replaces the outer wrapper shell; `exec ./logflare start` replaces `run.sh`'s own shell once
// the migrate step succeeded) — necessary but, measured, NOT yet sufficient: with beam.smp as
// PID 1 a `docker stop -t 10` still burns the full grace period (~10.5s), so Logflare's own
// SIGTERM shutdown hangs upstream, the same class of problem postgres-meta had before
// postgres-meta#1103. Keep the execs (one less layer between the signal and the BEAM, and they
// become load-bearing the moment upstream fixes its handler); the remaining ~10s needs an
// upstream Logflare image fix. The `migrate && start` sequencing is unchanged and deliberate —
// see the doc comment above (#6088). Stop timing is outside the Go-parity surface (ADR 0016).
const LEGACY_LOGFLARE_ENTRYPOINT_SCRIPT =
  "cat <<'EOF' > run.sh && exec sh run.sh\n./logflare eval Logflare.Release.migrate &&\nexec ./logflare start --sname logflare\nEOF\n";

export interface LegacyLogflareContainerSpecInput {
  /**
   * The already-resolved `config.analytics.image`. Not part of the decoded
   * `@supabase/config` schema; resolution is the caller's responsibility.
   */
  readonly image: string;
  /** The project id, used to derive this container's own name via {@link legacyServiceContainerName}. */
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
   * `config.analytics.gcp_jwt_path` — only read when {@link backend} is
   * `"bigquery"`. Joined onto {@link workdir} UNCONDITIONALLY — an empty
   * string still produces a (degenerate) bind mount of `workdir` itself,
   * the behavior when the field is unset.
   */
  readonly gcpJwtPath: string;
  /** The process working directory, used to resolve {@link gcpJwtPath} to a host path. */
  readonly workdir: string;
  /** The `db` container's own hostname. */
  readonly dbHost: string;
  /** Hardcoded `5432`. */
  readonly dbPort: number;
  /**
   * Hardcoded `"postgres"` — used only for the Postgres-backend
   * `POSTGRES_BACKEND_URL` env var, NOT for `DB_USERNAME` (see
   * {@link LEGACY_LOGFLARE_DB_USERNAME}'s doc comment).
   */
  readonly dbUser: string;
  /** `config.db.password`. */
  readonly dbPassword: string;
}

/** Builds the `docker create` spec for the Logflare/analytics container. */
export function legacyBuildLogflareContainerSpec(
  input: LegacyLogflareContainerSpecInput,
): LegacyStartContainerSpec {
  const env: Record<string, string> = {
    DB_DATABASE: "_supabase",
    DB_HOSTNAME: input.dbHost,
    DB_PORT: String(input.dbPort),
    DB_SCHEMA: "_analytics",
    DB_USERNAME: LEGACY_LOGFLARE_DB_USERNAME,
    DB_PASSWORD: input.dbPassword,
    LOGFLARE_MIN_CLUSTER_SIZE: "1",
    LOGFLARE_SINGLE_TENANT: "true",
    LOGFLARE_SUPABASE_MODE: "true",
    LOGFLARE_PRIVATE_ACCESS_TOKEN: LEGACY_LOGFLARE_API_KEY,
    LOGFLARE_LOG_LEVEL: "warn",
    LOGFLARE_NODE_HOST: "127.0.0.1",
    // The literal env VALUE includes the single quotes — this is set directly
    // on the container env, never through a shell, so the quotes are not
    // stripped anywhere.
    LOGFLARE_FEATURE_FLAG_OVERRIDE: "'multibackend=true'",
    RELEASE_COOKIE: "cookie",
  };

  const binds: Array<string> = [];

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
    containerName: legacyServiceContainerName(LEGACY_LOGFLARE_CONTAINER_SUFFIX, input.projectId),
    hostname: "127.0.0.1",
    env,
    entrypoint: "sh",
    cmd: ["-c", LEGACY_LOGFLARE_ENTRYPOINT_SCRIPT],
    binds,
    exposedPorts: [{ containerPort: "4000" }],
    ports: [{ hostPort: String(input.port), containerPort: "4000" }],
    healthcheck: {
      test: ["CMD", "curl", "-sSfL", "--head", "-o", "/dev/null", "http://127.0.0.1:4000/health"],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
      startPeriodSeconds: 10,
    },
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    networkAliases: [LEGACY_LOGFLARE_CONTAINER_SUFFIX],
    labels: {},
  };
}
