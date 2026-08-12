/**
 * Port of Go's "Start pooler" block (`apps/cli-go/internal/start/start.go:
 * 1193-1268`, deleted in CLI-1966; last present at commit a253ccba2), gated
 * on `config.db.pooler.enabled` — the gate itself is
 * `start.handler.ts`'s job (a later task), not this module's; this file only
 * builds the `docker create` spec (plus the pure tenant-provisioning script it
 * embeds — see below).
 *
 * IMPORTANT — how Go actually provisions the Supavisor tenant: it is NOT a
 * post-start `docker exec`. Go renders `pooler.exs` (via
 * `legacyRenderStartPoolerExs`, already ported in `../lib/template-render.ts`)
 * BEFORE the container is created, then bakes the rendered script directly
 * into the container's own startup `Cmd`
 * (`/bin/sh -c "/app/bin/migrate && /app/bin/supavisor eval '<script>' &&
 * /app/bin/server"`, `start.go:1234-1237`) — overriding the image's default
 * `CMD` while keeping its own `ENTRYPOINT` (no `Entrypoint` field is set here
 * at all, matching `docker-create-args.ts`'s documented Pooler precedent).
 * There is no separate post-start step: tenant creation runs once, as part of
 * the container's first boot, inside the same shell invocation that also runs
 * `/app/bin/migrate`.
 *
 * Go's literal shell-embed of `<script>` (which carries the DB password) is
 * safe in Go's own architecture — it calls `Docker.ContainerCreate` over the
 * Engine API directly, so that `Cmd` string never becomes a subprocess's own
 * argv. THIS PORT SHELLS OUT to a real `docker create`, so it deliberately
 * diverges: the rendered script travels via
 * {@link LegacyStartContainerSpec.secretFiles} instead (a short-lived HOST
 * temp file, mode `0644`, `docker cp`'d straight into the container at
 * {@link LEGACY_SUPAVISOR_POOLER_TENANT_CONTAINER_PATH}) — Supavisor itself
 * runs fully as root in Go's image, so it is unaffected by the non-root
 * read issue that motivates `0644` for Kong/Postgres (see
 * `legacyCopyStartSecretFileIntoContainer`'s doc comment); the file mode is simply
 * widened here for consistency with the other staged secrets, and
 * {@link legacyBuildSupavisorStartCmd} only ever references that FIXED path —
 * never the secret content itself (CWE-214/522). See that function's doc
 * comment for the resulting quoting nuance. {@link legacyBuildSupavisorStartCmd}
 * is exported separately (rather than inlined) so a later orchestrator can
 * unit-test or reuse the exact shell-embedding shape independently of the
 * rest of the spec.
 */

import { legacyServiceContainerName } from "../../../shared/legacy-docker-ids.ts";
import type { LegacyStartContainerSpec } from "../../../shared/db-bootstrap/docker-create-args.ts";
import {
  legacyRenderStartPoolerExs,
  type LegacyStartPoolerExsFields,
} from "../lib/template-render.ts";

/** `utils.PoolerAliases[0]` (`apps/cli-go/internal/utils/config.go:49`) — also this service's `containerSuffix` in `LEGACY_SERVICE_CATALOG`. */
const LEGACY_SUPAVISOR_CONTAINER_SUFFIX = "pooler";

/** `Config.Db.Pooler.TenantId` default (`apps/cli-go/pkg/config/config.go:465`) — `toml:"-"`, never configurable, so hardcoded here exactly like Go's own compile-time constant. */
const LEGACY_SUPAVISOR_TENANT_ID = "pooler-dev";
/** `Config.Db.Pooler.EncryptionKey` default (`config.go:466`) — `toml:"-"`. */
const LEGACY_SUPAVISOR_ENCRYPTION_KEY = "12345678901234567890123456789032";
/** `Config.Db.Pooler.SecretKeyBase` default (`config.go:467`) — `toml:"-"`. */
const LEGACY_SUPAVISOR_SECRET_KEY_BASE =
  "EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG";

/** `portSession` (`start.go:1195`). */
const LEGACY_SUPAVISOR_SESSION_PORT = "5432";
/** `portTransaction` (`start.go:1196`). */
const LEGACY_SUPAVISOR_TRANSACTION_PORT = "6543";

/**
 * The fixed in-container path the rendered `pooler.exs` tenant script is
 * `docker cp`'d to (see {@link legacyBuildSupavisorContainerSpec}'s
 * `secretFiles`) — no Go equivalent, since Go never writes this script to a
 * file at all.
 */
const LEGACY_SUPAVISOR_POOLER_TENANT_CONTAINER_PATH = "/app/pooler_tenant.exs";

/**
 * Go embeds the rendered `pooler.exs` script directly into the container's
 * `Cmd` via an UNESCAPED single-quote wrap (`start.go:1234-1237`,
 * `fmt.Sprintf("/app/bin/migrate && /app/bin/supavisor eval '%s' &&
 * /app/bin/server", poolerTenantBuf.String())`, with NO shell-escaping of
 * embedded characters) — this module's header comment explains why that's
 * safe for Go's Engine-API architecture but not for this port's, which shells
 * out to a real `docker create`.
 *
 * This `Cmd` instead reads the script from
 * {@link LEGACY_SUPAVISOR_POOLER_TENANT_CONTAINER_PATH} at container startup:
 * `eval "$(cat <path>)"`'s double-quoted command substitution passes the
 * file's content to `eval` as a single argument, the same way Go's
 * single-quote wrap passed the inline literal as a single argument. Two
 * differences from Go's raw embed, both immaterial for every value these
 * fields can take today: `$()` strips the script's own trailing newline
 * (irrelevant to `Code.eval_string`), and the surrounding double quotes
 * re-expand a `$`/backtick sequence in the file's content where Go's single
 * quotes never would (every interpolated `pooler.exs` field is a fixed/
 * internal value today — `db.password` in particular has no config.toml
 * field at all, always literally `"postgres"`, see `postgres.service.ts`'s
 * `LEGACY_POSTGRES_PASSWORD` — none of which contain `$`, a backtick, or a
 * single quote). A future caller that ever makes one of these fields
 * genuinely attacker-controlled must revisit this quoting, exactly as it
 * would have had to revisit Go's own single-quote wrap.
 */
export function legacyBuildSupavisorStartCmd(): ReadonlyArray<string> {
  return [
    "/bin/sh",
    "-c",
    `/app/bin/migrate && /app/bin/supavisor eval "$(cat ${LEGACY_SUPAVISOR_POOLER_TENANT_CONTAINER_PATH})" && /app/bin/server`,
  ];
}

export interface LegacySupavisorContainerSpecInput {
  /**
   * `container.Config.Image` — the already-resolved `config.db.pooler.image`.
   * Not part of the decoded `@supabase/config` schema (Go's own
   * `Pooler.Image` field is `toml:"-"`); resolution is the caller's
   * responsibility.
   */
  readonly image: string;
  /** Go's `Config.ProjectId`, used to derive `utils.PoolerId` via {@link legacyServiceContainerName}. */
  readonly projectId: string;
  /** `container.HostConfig.NetworkMode`'s target — resolved once per `start` run, not per-container. */
  readonly networkId: string;
  /** `config.db.pooler.port` — the single host port published, whose container-side target depends on {@link poolMode} (`start.go:1194-1200`). */
  readonly port: number;
  /** `config.db.pooler.pool_mode` — also the pooler.exs tenant's `ModeType`/`mode_type`. */
  readonly poolMode: "transaction" | "session";
  /** `config.db.pooler.default_pool_size` — also the tenant's `DefaultPoolSize`/`default_pool_size` (and each user's own `pool_size`). */
  readonly defaultPoolSize: number;
  /** `config.db.pooler.max_client_conn` — also the tenant's `DefaultMaxClients`/`default_max_clients`. */
  readonly maxClientConn: number;
  /** `config.auth.jwt_secret` (`Config.Auth.JwtSecret.Value`) — used for BOTH `API_JWT_SECRET` and `METRICS_JWT_SECRET` (`start.go:1227-1228`). */
  readonly jwtSecret: string;
  /** `dbConfig.Host` (`utils.DbId` on the default path). Also the tenant's `DbHost`/`db_host`. */
  readonly dbHost: string;
  /** `dbConfig.Port` (`5432` on the default path). Also the tenant's `DbPort`/`db_port`. */
  readonly dbPort: number;
  /** `dbConfig.User` (`"postgres"` on the default path) — used only for `DATABASE_URL` (Supavisor's own metadata store), NOT the tenant script. */
  readonly dbUser: string;
  /** `dbConfig.Password` — used for both `DATABASE_URL` and the tenant's `DbPassword`/`db_password`. */
  readonly dbPassword: string;
  /** `dbConfig.Database` (`"postgres"` on the default path) — the tenant's `DbDatabase`/`db_database` (the database Supavisor proxies, distinct from its own `_supabase` metadata database in `DATABASE_URL`). */
  readonly dbDatabase: string;
}

/** Builds the `docker create` spec for the Supavisor/pooler container (`start.go:1193-1268`). */
export function legacyBuildSupavisorContainerSpec(
  input: LegacySupavisorContainerSpecInput,
): LegacyStartContainerSpec {
  const tenantFields: LegacyStartPoolerExsFields = {
    dbHost: input.dbHost,
    dbPort: input.dbPort,
    dbDatabase: input.dbDatabase,
    dbPassword: input.dbPassword,
    externalId: LEGACY_SUPAVISOR_TENANT_ID,
    modeType: input.poolMode,
    defaultMaxClients: input.maxClientConn,
    defaultPoolSize: input.defaultPoolSize,
  };
  const tenantScript = legacyRenderStartPoolerExs(tenantFields);
  const dockerPort =
    input.poolMode === "session"
      ? LEGACY_SUPAVISOR_SESSION_PORT
      : LEGACY_SUPAVISOR_TRANSACTION_PORT;

  return {
    image: input.image,
    containerName: legacyServiceContainerName(LEGACY_SUPAVISOR_CONTAINER_SUFFIX, input.projectId),
    env: {
      PORT: "4000",
      PROXY_PORT_SESSION: LEGACY_SUPAVISOR_SESSION_PORT,
      PROXY_PORT_TRANSACTION: LEGACY_SUPAVISOR_TRANSACTION_PORT,
      DATABASE_URL: `ecto://${input.dbUser}:${input.dbPassword}@${input.dbHost}:${input.dbPort}/_supabase`,
      CLUSTER_POSTGRES: "true",
      SECRET_KEY_BASE: LEGACY_SUPAVISOR_SECRET_KEY_BASE,
      VAULT_ENC_KEY: LEGACY_SUPAVISOR_ENCRYPTION_KEY,
      API_JWT_SECRET: input.jwtSecret,
      METRICS_JWT_SECRET: input.jwtSecret,
      REGION: "local",
      RUN_JANITOR: "true",
      ERL_AFLAGS: "-proto_dist inet_tcp",
      RLIMIT_NOFILE: "",
    },
    cmd: legacyBuildSupavisorStartCmd(),
    secretFiles: [
      { containerPath: LEGACY_SUPAVISOR_POOLER_TENANT_CONTAINER_PATH, content: tenantScript },
    ],
    binds: [],
    exposedPorts: [
      { containerPort: "4000" },
      { containerPort: LEGACY_SUPAVISOR_SESSION_PORT },
      { containerPort: LEGACY_SUPAVISOR_TRANSACTION_PORT },
    ],
    ports: [{ hostPort: String(input.port), containerPort: dockerPort }],
    healthcheck: {
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
    networkAliases: [LEGACY_SUPAVISOR_CONTAINER_SUFFIX],
    labels: {},
  };
}
