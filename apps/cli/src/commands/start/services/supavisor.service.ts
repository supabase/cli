/**
 * Supavisor/pooler container spec builder, gated on
 * `config.db.pooler.enabled` — the gate itself is `start.handler.ts`'s job
 * (a later task), not this module's; this file only builds the
 * `docker create` spec (plus the pure tenant-provisioning script it embeds
 * — see below).
 *
 * IMPORTANT — how the Supavisor tenant is actually provisioned: it is NOT a
 * post-start `docker exec`. The rendered `pooler.exs` (via
 * `renderStartPoolerExs`, already ported in `../lib/template-render.ts`)
 * is built BEFORE the container is created, then baked directly into the
 * container's own startup `Cmd`
 * (`/bin/sh -c "/app/bin/migrate && /app/bin/supavisor eval '<script>' &&
 * /app/bin/server"`) — overriding the image's default `CMD` while keeping
 * its own `ENTRYPOINT` (no `Entrypoint` field is set here at all, matching
 * `docker-create-args.ts`'s documented Pooler precedent). There is no
 * separate post-start step: tenant creation runs once, as part of the
 * container's first boot, inside the same shell invocation that also runs
 * `/app/bin/migrate`.
 *
 * A literal shell-embed of `<script>` (which carries the DB password) would
 * only be safe with an architecture that calls the Docker Engine API
 * directly, so that `Cmd` string never becomes a subprocess's own argv.
 * THIS PORT SHELLS OUT to a real `docker create`, where that would leak, so
 * it deliberately diverges: the rendered script travels via
 * {@link StartContainerSpec.secretFiles} instead (an in-memory tar
 * entry, mode `0644`, streamed via `docker cp - <id>:/` into the container at
 * {@link SUPAVISOR_POOLER_TENANT_CONTAINER_PATH}) — Supavisor itself
 * runs fully as root in its image, so it is unaffected by the non-root read
 * issue that motivates `0644` for Kong/Postgres (see
 * `copyStartSecretFilesIntoContainer`'s doc comment); the file mode is
 * simply widened here for consistency with the other secrets, and
 * {@link buildSupavisorStartCmd} only ever references that FIXED path
 * — never the secret content itself (CWE-214/522). See that function's doc
 * comment for the resulting quoting nuance. {@link buildSupavisorStartCmd}
 * is exported separately (rather than inlined) so a later orchestrator can
 * unit-test or reuse the exact shell-embedding shape independently of the
 * rest of the spec.
 */

import { serviceContainerName } from "../../../command-internal/docker-ids.ts";
import type { StartContainerSpec } from "../../../command-internal/db-bootstrap/docker-create-args.ts";
import { slimWgetHealthcheck } from "../../../command-internal/db-bootstrap/slim-runtime.ts";
import { usesSlimImageRuntime } from "../../../shared/services/slim-images.ts";
import { renderStartPoolerExs, type StartPoolerExsFields } from "../lib/template-render.ts";

/** The Supavisor network alias — also this service's `containerSuffix` in `SERVICE_CATALOG`. */
const SUPAVISOR_CONTAINER_SUFFIX = "pooler";

/** The Supavisor tenant id default — never configurable, so hardcoded here. */
const SUPAVISOR_TENANT_ID = "pooler-dev";
/** The Supavisor encryption key default — never configurable. */
const SUPAVISOR_ENCRYPTION_KEY = "12345678901234567890123456789032";
/** The Supavisor secret key base default — never configurable. */
const SUPAVISOR_SECRET_KEY_BASE =
  "EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG";

/** The Supavisor session-mode port. */
const SUPAVISOR_SESSION_PORT = "5432";
/** The Supavisor transaction-mode port. */
const SUPAVISOR_TRANSACTION_PORT = "6543";

/**
 * The fixed in-container path the rendered `pooler.exs` tenant script is
 * `docker cp`'d to (see {@link buildSupavisorContainerSpec}'s
 * `secretFiles`).
 */
const SUPAVISOR_POOLER_TENANT_CONTAINER_PATH = "/app/pooler_tenant.exs";

/**
 * An unescaped single-quote wrap around the rendered `pooler.exs` script
 * embedded directly into the container's `Cmd` would only be safe with an
 * architecture that calls the Docker Engine API directly, so that `Cmd`
 * string never becomes a subprocess's own argv — see this module's header
 * comment for why that isn't this port's architecture.
 *
 * This `Cmd` instead reads the script from
 * {@link SUPAVISOR_POOLER_TENANT_CONTAINER_PATH} at container
 * startup: `eval "$(cat <path>)"`'s double-quoted command substitution
 * passes the file's content to `eval` as a single argument, the same way an
 * inline single-quote wrap would pass a literal as a single argument. Two
 * quoting nuances, both immaterial for every value these fields can take
 * today: `$()` strips the script's own trailing newline (irrelevant to
 * `Code.eval_string`), and the surrounding double quotes re-expand a
 * `$`/backtick sequence in the file's content that a single-quote wrap
 * never would (every interpolated `pooler.exs` field is a fixed/internal
 * value today — `db.password` in particular has no config.toml field at
 * all, always literally `"postgres"`, see `postgres.service.ts`'s
 * `POSTGRES_PASSWORD` — none of which contain `$`, a backtick, or a
 * single quote). A future caller that ever makes one of these fields
 * genuinely attacker-controlled must revisit this quoting.
 */
export function buildSupavisorStartCmd(): ReadonlyArray<string> {
  return [
    "/bin/sh",
    "-c",
    `/app/bin/migrate && /app/bin/supavisor eval "$(cat ${SUPAVISOR_POOLER_TENANT_CONTAINER_PATH})" && /app/bin/server`,
  ];
}

export interface SupavisorContainerSpecInput {
  /**
   * The already-resolved `config.db.pooler.image`. Not part of the decoded
   * `@supabase/config` schema; resolution is the caller's responsibility.
   */
  readonly image: string;
  /** The project id, used to derive this container's own name via {@link serviceContainerName}. */
  readonly projectId: string;
  /** `container.HostConfig.NetworkMode`'s target — resolved once per `start` run, not per-container. */
  readonly networkId: string;
  /** `config.db.pooler.port` — the single host port published, whose container-side target depends on {@link poolMode}. */
  readonly port: number;
  /** `config.db.pooler.pool_mode` — also the pooler.exs tenant's `ModeType`/`mode_type`. */
  readonly poolMode: "transaction" | "session";
  /** `config.db.pooler.default_pool_size` — also the tenant's `DefaultPoolSize`/`default_pool_size` (and each user's own `pool_size`). */
  readonly defaultPoolSize: number;
  /** `config.db.pooler.max_client_conn` — also the tenant's `DefaultMaxClients`/`default_max_clients`. */
  readonly maxClientConn: number;
  /** `config.auth.jwt_secret` — used for BOTH `API_JWT_SECRET` and `METRICS_JWT_SECRET`. */
  readonly jwtSecret: string;
  /** The `db` container's own hostname. Also the tenant's `DbHost`/`db_host`. */
  readonly dbHost: string;
  /** Hardcoded `5432`. Also the tenant's `DbPort`/`db_port`. */
  readonly dbPort: number;
  /** Hardcoded `"postgres"` — used only for `DATABASE_URL` (Supavisor's own metadata store), NOT the tenant script. */
  readonly dbUser: string;
  /** Used for both `DATABASE_URL` and the tenant's `DbPassword`/`db_password`. */
  readonly dbPassword: string;
  /** Hardcoded `"postgres"` — the tenant's `DbDatabase`/`db_database` (the database Supavisor proxies, distinct from its own `_supabase` metadata database in `DATABASE_URL`). */
  readonly dbDatabase: string;
}

/** Builds the `docker create` spec for the Supavisor/pooler container. */
export function buildSupavisorContainerSpec(
  input: SupavisorContainerSpecInput,
): StartContainerSpec {
  const tenantFields: StartPoolerExsFields = {
    dbHost: input.dbHost,
    dbPort: input.dbPort,
    dbDatabase: input.dbDatabase,
    dbPassword: input.dbPassword,
    externalId: SUPAVISOR_TENANT_ID,
    modeType: input.poolMode,
    defaultMaxClients: input.maxClientConn,
    defaultPoolSize: input.defaultPoolSize,
  };
  const tenantScript = renderStartPoolerExs(tenantFields);
  const dockerPort =
    input.poolMode === "session" ? SUPAVISOR_SESSION_PORT : SUPAVISOR_TRANSACTION_PORT;

  return {
    image: input.image,
    containerName: serviceContainerName(SUPAVISOR_CONTAINER_SUFFIX, input.projectId),
    env: {
      PORT: "4000",
      PROXY_PORT_SESSION: SUPAVISOR_SESSION_PORT,
      PROXY_PORT_TRANSACTION: SUPAVISOR_TRANSACTION_PORT,
      DATABASE_URL: `ecto://${input.dbUser}:${input.dbPassword}@${input.dbHost}:${input.dbPort}/_supabase`,
      CLUSTER_POSTGRES: "true",
      SECRET_KEY_BASE: SUPAVISOR_SECRET_KEY_BASE,
      VAULT_ENC_KEY: SUPAVISOR_ENCRYPTION_KEY,
      API_JWT_SECRET: input.jwtSecret,
      METRICS_JWT_SECRET: input.jwtSecret,
      REGION: "local",
      RUN_JANITOR: "true",
      ERL_AFLAGS: "-proto_dist inet_tcp",
      RLIMIT_NOFILE: "",
    },
    cmd: buildSupavisorStartCmd(),
    secretFiles: [{ containerPath: SUPAVISOR_POOLER_TENANT_CONTAINER_PATH, content: tenantScript }],
    binds: [],
    exposedPorts: [
      { containerPort: "4000" },
      { containerPort: SUPAVISOR_SESSION_PORT },
      { containerPort: SUPAVISOR_TRANSACTION_PORT },
    ],
    ports: [{ hostPort: String(input.port), containerPort: dockerPort }],
    // Slim pooler ships wget, not curl.
    healthcheck: usesSlimImageRuntime(input.image)
      ? slimWgetHealthcheck("http://127.0.0.1:4000/api/health")
      : {
          test: [
            "CMD",
            "curl",
            "-sSfL",
            "--head",
            "-o",
            "/dev/null",
            "http://127.0.0.1:4000/api/health",
          ],
          intervalSeconds: 10,
          timeoutSeconds: 2,
          retries: 3,
        },
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    networkAliases: [SUPAVISOR_CONTAINER_SUFFIX],
    labels: {},
  };
}
