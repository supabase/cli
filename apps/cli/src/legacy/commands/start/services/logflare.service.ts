/**
 * Port of Go's "Start Logflare" block (`apps/cli-go/internal/start/start.go:
 * 313-394`), gated on `config.analytics.enabled` — the gate itself is
 * `start.handler.ts`'s job (a later task), not this module's; this file only
 * builds the `docker create` spec.
 *
 * Two things make this the fullest worked example among the three real
 * services ported in this file group:
 *
 * - A custom `Entrypoint`/`Cmd` pair that writes and runs its own `run.sh`,
 *   because the image's own entrypoint conflicts with the healthcheck due to
 *   a 15-second sleep
 *   (https://github.com/Logflare/logflare/blob/staging/run.sh#L35).
 * - A `config.analytics.backend` branch (`postgres` vs `bigquery`,
 *   `start.go:333-348`) that appends different env vars (and, for BigQuery
 *   only, a bind mount for the GCP service-account JSON).
 */

import { join } from "node:path";

import { legacyServiceContainerName } from "../../../shared/legacy-docker-ids.ts";
import type { LegacyStartContainerSpec } from "../lib/docker-create-args.ts";

/** `utils.LogflareAliases[0]` (`apps/cli-go/internal/utils/config.go:47`) — also this service's `containerSuffix` in `LEGACY_SERVICE_CATALOG`. */
const LEGACY_LOGFLARE_CONTAINER_SUFFIX = "analytics";

/**
 * `utils.SUPERUSER_ROLE` (`apps/cli-go/internal/utils/connect.go:338`) — the DB
 * user Logflare's own Ecto connection authenticates as. Distinct from
 * {@link LegacyLogflareContainerSpecInput.dbUser} (`dbConfig.User = "postgres"`
 * in Go), which is used only for the Postgres-backend `POSTGRES_BACKEND_URL`
 * below (`start.go:344-347`) — Go really does use two different DB users for
 * two different env vars in this one block.
 */
const LEGACY_LOGFLARE_DB_USERNAME = "supabase_admin";

/**
 * `Config.Analytics.ApiKey`'s only possible value
 * (`apps/cli-go/pkg/config/config.go:307,529`). The field is `toml:"-"` —
 * excluded from `config.toml` unmarshalling entirely — so this can never
 * actually vary; hardcoding it here (rather than threading it through as an
 * input) mirrors that Go compile-time constant exactly.
 */
const LEGACY_LOGFLARE_API_KEY = "api-key";

/**
 * Go's Logflare entrypoint script (`start.go:358-362`): the image's own
 * entrypoint conflicts with the container healthcheck due to a 15-second
 * sleep, so Go writes its own `run.sh` and runs that instead.
 *
 * Deliberate divergence from Go, do not revert in a parity sweep (issue
 * #6088): `migrate && start`, so a failed migrate exits the container and the
 * `unless-stopped` restart policy retries until the db is ready — Go boots
 * Logflare against the unmigrated database, where Oban dies on the missing
 * `public.oban_jobs`.
 */
const LEGACY_LOGFLARE_ENTRYPOINT_SCRIPT =
  "cat <<'EOF' > run.sh && sh run.sh\n./logflare eval Logflare.Release.migrate &&\n./logflare start --sname logflare\nEOF\n";

export interface LegacyLogflareContainerSpecInput {
  /**
   * `container.Config.Image` — the already-resolved `config.analytics.image`.
   * Not part of the decoded `@supabase/config` schema (Go's own
   * `Analytics.Image` field is `toml:"-"`); resolution is the caller's
   * responsibility.
   */
  readonly image: string;
  /** Go's `Config.ProjectId`, used to derive `utils.LogflareId` via {@link legacyServiceContainerName}. */
  readonly projectId: string;
  /** `container.HostConfig.NetworkMode`'s target — resolved once per `start` run, not per-container. */
  readonly networkId: string;
  /** `config.analytics.port` — published as `4000/tcp`. */
  readonly port: number;
  /** `config.analytics.backend` (`start.go:333`). */
  readonly backend: "postgres" | "bigquery";
  /** `config.analytics.gcp_project_id` — only read when {@link backend} is `"bigquery"` (`start.go:340`). */
  readonly gcpProjectId: string;
  /** `config.analytics.gcp_project_number` — only read when {@link backend} is `"bigquery"` (`start.go:341`). */
  readonly gcpProjectNumber: string;
  /**
   * `config.analytics.gcp_jwt_path` — only read when {@link backend} is
   * `"bigquery"` (`start.go:335-336`). Joined onto {@link workdir}
   * UNCONDITIONALLY, exactly like Go's own `filepath.Join(workdir,
   * GcpJwtPath)` — an empty string still produces a (degenerate) bind mount of
   * `workdir` itself, matching Go's behavior when the field is unset.
   */
  readonly gcpJwtPath: string;
  /** `os.Getwd()` at the call site (`start.go:308-311`) — the process working directory, used to resolve {@link gcpJwtPath} to a host path. */
  readonly workdir: string;
  /** `dbConfig.Host` (`utils.DbId` on the default path — see `start.go:66-72`). */
  readonly dbHost: string;
  /** `dbConfig.Port` (`5432` on the default path). */
  readonly dbPort: number;
  /**
   * `dbConfig.User` (`"postgres"` on the default path) — used only for the
   * Postgres-backend `POSTGRES_BACKEND_URL` env var, NOT for
   * `DB_USERNAME` (see {@link LEGACY_LOGFLARE_DB_USERNAME}'s doc comment).
   */
  readonly dbUser: string;
  /** `dbConfig.Password` (`Config.Db.Password`). */
  readonly dbPassword: string;
}

/** Builds the `docker create` spec for the Logflare/analytics container (`start.go:313-394`). */
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
    // The literal env VALUE includes the single quotes (start.go:328) — Go sets
    // this directly on container.Config.Env, never through a shell, so the
    // quotes are not stripped anywhere.
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
