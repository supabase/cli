/**
 * Builds the `docker create` spec for the Supavisor/pooler container. Gated on
 * `config.db.pooler.enabled` by the caller.
 *
 * The tenant is provisioned by baking the rendered `pooler.exs` script into the container's own
 * startup `Cmd`, not via a post-start `docker exec`. The script travels via
 * {@link StartContainerSpec.secretFiles} (`docker cp`'d in) rather than being embedded literally
 * in `Cmd`, because `Cmd` becomes real process argv and would leak the DB password it carries
 * (CWE-214/522); {@link buildSupavisorStartCmd} only ever references the resulting file's fixed
 * path, never the secret content.
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

/** The fixed in-container path the rendered `pooler.exs` tenant script is `docker cp`'d to. */
const SUPAVISOR_POOLER_TENANT_CONTAINER_PATH = "/app/pooler_tenant.exs";

/**
 * Reads the tenant script from {@link SUPAVISOR_POOLER_TENANT_CONTAINER_PATH} at container
 * startup (`eval "$(cat <path>)"`) instead of embedding it as a quoted literal in `Cmd` — see this
 * module's header for why. The double-quoted command substitution passes the file's content to
 * `eval` as a single argument, the same as a single-quote literal would, except it also
 * re-expands any `$`/backtick in the content; every interpolated `pooler.exs` field is fixed or
 * internal today, so none can contain those characters. Revisit the quoting if a field ever
 * becomes attacker-controlled.
 */
export function buildSupavisorStartCmd(): ReadonlyArray<string> {
  return [
    "/bin/sh",
    "-c",
    `/app/bin/migrate && /app/bin/supavisor eval "$(cat ${SUPAVISOR_POOLER_TENANT_CONTAINER_PATH})" && /app/bin/server`,
  ];
}

export interface SupavisorContainerSpecInput {
  /** The already-resolved `config.db.pooler.image`; resolution is the caller's responsibility. */
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
  /** `config.auth.jwt_secret`, used for both `API_JWT_SECRET` and `METRICS_JWT_SECRET`. */
  readonly jwtSecret: string;
  /** The `db` container's own hostname. Also the tenant's `DbHost`/`db_host`. */
  readonly dbHost: string;
  /** Hardcoded `5432`. Also the tenant's `DbPort`/`db_port`. */
  readonly dbPort: number;
  /** Hardcoded `"postgres"`, used only for `DATABASE_URL` (Supavisor's own metadata store) — not the tenant script. */
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
