/**
 * Kong container spec builder — port of Go's "Start Kong" block
 * (`apps/cli-go/internal/start/start.go:486-627`), gated on
 * `!isContainerExcluded(config.api.kong_image, excluded)` (Kong has no
 * `enabled` flag of its own — it is the stack's mandatory gateway) — see
 * `legacy-service-catalog.ts`'s `kong` entry (`excludeKey: "kong"`). Gating and
 * image resolution/pre-pull are the caller's job (a future `start.handler.ts`);
 * this module only assembles the container spec once the caller has already
 * decided to start it, matching `docker-create-args.ts`'s "image already
 * resolved/pulled" contract.
 *
 * How Go injects `kong.yml`/`custom_nginx.template`/the TLS cert+key into the
 * container (`start.go:588-601`): a single `sh -c` entrypoint script with
 * FOUR chained `cat <<'EOF' > <path> && \` heredocs (joined by shell
 * line-continuation into one logical command line), all four bodies —
 * including `kong.yml`'s embedded service-role-key-derived bearer/query
 * tokens and the TLS private key — landing directly in the container's own
 * `Cmd`. Safe for Go: it builds `container.Config` structs and calls
 * `Docker.ContainerCreate` over the Engine API directly, so that `Cmd` string
 * never becomes a subprocess's own argv. THIS PORT SHELLS OUT to a real
 * `docker create`, so it deliberately diverges here (CWE-214/522, `ps aux`/
 * `/proc/<pid>/cmdline`): `kong.yml` (the service-role key) and the TLS
 * cert/key (the highest-value secret — a private key) travel via
 * {@link LegacyStartContainerSpec.secretFiles} instead — a short-lived HOST
 * temp file, mode `0644` (world-readable — Kong's image runs its process as
 * uid 100 `kong`, a non-root user, and `docker cp`'s tar transfer preserves
 * the host file's mode verbatim, so `0600` would make it unreadable
 * in-container; see `legacyCopyStartSecretFileIntoContainer`'s doc comment),
 * `docker cp`'d straight into the container at the exact fixed paths
 * `KONG_DECLARATIVE_CONFIG`/`KONG_SSL_CERT`/`KONG_SSL_CERT_KEY` already
 * reference — and never appear in this process's own argv. Only
 * `custom_nginx.template`, which carries no secret content, still travels via
 * the heredoc entrypoint script, matching Go exactly.
 *
 * The TLS cert/key `secretFiles` entries are still ALWAYS present — never a
 * conditional bind — for the same reason Go always wrote them:
 * `KONG_SSL_CERT`/`KONG_SSL_CERT_KEY` reference fixed in-container paths
 * unconditionally. Their content is never empty either: Go's `NewConfig`
 * seeds `Api.Tls.{CertContent,KeyContent}` with the embedded default
 * localhost cert/key (`pkg/config/config.go:452-455`), and only overwrites
 * them from disk when TLS is enabled AND both `cert_path`/`key_path` are
 * configured — see {@link LegacyKongContainerSpecInput.tlsCertContent}'s doc
 * comment. {@link legacyBuildKongEntrypointScript}
 * reproduces the remaining `custom_nginx.template` heredoc + exec line
 * byte-for-byte; see its doc comment for the exact shell mechanics.
 *
 * Kong mints no JWTs of its own: `BearerToken`/`QueryToken` (`start.go:501-521`)
 * are Kong `request-transformer`/lua expression STRINGS built by
 * `fmt.Sprintf` from the four already-generated API keys
 * (`utils.Config.Auth.{SecretKey,ServiceRoleKey,PublishableKey,AnonKey}.Value`
 * — see `legacy-local-config-values.ts`'s `LegacyLocalConfigValues`, which
 * already resolves all four). {@link legacyBuildKongBearerToken}/
 * {@link legacyBuildKongQueryToken} reproduce those two `fmt.Sprintf` calls
 * exactly; nothing in this module calls `legacyGenerateGoJwt` itself.
 */

import * as nodePath from "node:path";

import type { LegacyStartContainerSpec } from "../../../shared/db-bootstrap/docker-create-args.ts";
import { legacyEnvOrDefault } from "../lib/legacy-env-or-default.ts";
import { legacyRenderStartKongYml } from "../lib/template-render.ts";
import { LEGACY_START_CUSTOM_NGINX_TEMPLATE } from "../templates/custom_nginx.template.ts";

/** `utils.KongAliases` (`apps/cli-go/internal/utils/config.go:37`) — a fixed, non-configurable constant. */
const LEGACY_KONG_NETWORK_ALIASES = ["kong", "api.supabase.internal"];

/** `nginxEmailTemplateDir` (`start.go:114`) — the fixed in-container directory email template mounts land in. */
const LEGACY_KONG_NGINX_EMAIL_TEMPLATE_DIR = "/home/kong/templates/email";

/** `nginxTemplateServerPort` (`start.go:115`) — the fixed port `custom_nginx.template`'s `email_templates` server listens on. */
const LEGACY_KONG_NGINX_TEMPLATE_SERVER_PORT = 8088;

export interface LegacyKongApiKeys {
  /** `Config.Auth.SecretKey.Value`. */
  readonly secretKey: string;
  /** `Config.Auth.ServiceRoleKey.Value`. */
  readonly serviceRoleKey: string;
  /** `Config.Auth.PublishableKey.Value`. */
  readonly publishableKey: string;
  /** `Config.Auth.AnonKey.Value`. */
  readonly anonKey: string;
}

/**
 * Go's `BearerToken` (`start.go:501-514`): a Kong `request-transformer` lua
 * expression, NOT a JWT — forwards a caller's own `Bearer sb_...` Authorization
 * header verbatim, otherwise maps a matching `apikey` header to the
 * corresponding `Bearer <key>` value, falling back to echoing `apikey` as-is.
 * Reproduces the `fmt.Sprintf` call exactly, including argument order
 * (secretKey, serviceRoleKey, publishableKey, anonKey).
 */
export function legacyBuildKongBearerToken(apiKeys: LegacyKongApiKeys): string {
  return (
    `$((headers.authorization ~= nil and headers.authorization:sub(1, 10) ~= 'Bearer sb_' and headers.authorization) ` +
    `or (headers.apikey == '${apiKeys.secretKey}' and 'Bearer ${apiKeys.serviceRoleKey}') ` +
    `or (headers.apikey == '${apiKeys.publishableKey}' and 'Bearer ${apiKeys.anonKey}') ` +
    `or headers.apikey)`
  );
}

/**
 * Go's `QueryToken` (`start.go:515-521`): the same mapping as
 * {@link legacyBuildKongBearerToken}, applied to the `apikey` query parameter
 * instead of a header, and without the `Bearer sb_...` passthrough branch
 * (there is no equivalent "already a query-string bearer" case).
 */
export function legacyBuildKongQueryToken(apiKeys: LegacyKongApiKeys): string {
  return (
    `$((query_params.apikey == '${apiKeys.secretKey}' and '${apiKeys.serviceRoleKey}') ` +
    `or (query_params.apikey == '${apiKeys.publishableKey}' and '${apiKeys.anonKey}') ` +
    `or query_params.apikey)`
  );
}

/**
 * Go's `envOrDefault("KONG_NGINX_WORKER_PROCESSES", "1")` (`start.go:583`,
 * helper at `start.go:1464-1471`): the operator's own shell value wins when
 * set (e.g. `KONG_NGINX_WORKER_PROCESSES=auto` for one worker per CPU core),
 * otherwise Go's default of a single worker to minimize local-stack memory
 * usage (Ref: supabase/cli#1271). By the time Go's `os.LookupEnv` runs here,
 * `Config.Load` has already merged any project dotenv file into the real
 * process env (`loadEnvIfExists`/`godotenv.Load`) — `projectEnvValues` is
 * this port's equivalent merged (dotenv + ambient shell, ambient-wins) view,
 * so a `KONG_NGINX_WORKER_PROCESSES` set only in a project dotenv file (not
 * the ambient shell) is honored too, matching Storage's identical
 * `VECTOR_*`-env handling (`storage.service.ts`). Kept separate from
 * {@link legacyBuildKongContainerSpec} (which stays a pure function of
 * already-resolved values, matching every other `start`-service builder) so
 * this one ambient-env read is independently testable and the builder itself
 * never touches `process.env`.
 */
export function legacyResolveKongNginxWorkerProcesses(
  projectEnvValues: Readonly<Record<string, string>> | undefined = undefined,
): string {
  return legacyEnvOrDefault("KONG_NGINX_WORKER_PROCESSES", "1", projectEnvValues);
}

export interface LegacyKongEmailTemplateMount {
  /**
   * Go's `mountEmailTemplates(id, contentPath string)` `id` parameter
   * (`start.go:527-542`): the raw `config.auth.email.template` key for a
   * template mount, or `<key>_notification` for an enabled
   * `config.auth.email.notification` entry (`start.go:551-557`) — the caller
   * is responsible for that suffixing and for filtering notifications down to
   * `enabled` ones; this module only reproduces the per-mount path derivation.
   */
  readonly id: string;
  /** `tmpl.ContentPath` — empty means "not configured", matching Go's `len(contentPath) == 0` early return (no bind emitted). */
  readonly contentPath: string;
}

/**
 * Go's `mountEmailTemplates` closure (`start.go:527-542`): resolves
 * `contentPath` to an absolute HOST path via `filepath.Abs` (relative to the
 * process's own working directory — NOT `<workdir>/supabase`, unlike
 * `legacyResolveEmailTemplateContentPath`'s existence-check base in
 * `legacy-config-validate.ts`, a genuinely different Go call site with a
 * different base), joins it onto the fixed in-container email-template
 * directory as `<id><ext-of-hostPath>` (`path.Join`, POSIX — the container is
 * always Linux regardless of the host OS, hence `nodePath.posix.join`, not the
 * platform-dependent `nodePath.join`), and formats the `rw` bind. Returns
 * `undefined` for an empty `contentPath`, matching Go's no-op early return
 * (no bind appended).
 */
export function legacyBuildKongEmailTemplateBind(
  mount: LegacyKongEmailTemplateMount,
  workdir: string,
): string | undefined {
  if (mount.contentPath.length === 0) return undefined;
  const hostPath = nodePath.isAbsolute(mount.contentPath)
    ? mount.contentPath
    : nodePath.resolve(workdir, mount.contentPath);
  const dockerPath = nodePath.posix.join(
    LEGACY_KONG_NGINX_EMAIL_TEMPLATE_DIR,
    `${mount.id}${nodePath.extname(hostPath)}`,
  );
  return `${hostPath}:${dockerPath}:rw`;
}

const LEGACY_KONG_ENTRYPOINT_HEAD =
  "cat <<'EOF' > /home/kong/custom_nginx.template && \\\n" +
  "./docker-entrypoint.sh kong docker-start --nginx-conf /home/kong/custom_nginx.template\n";

/**
 * Reproduces the surviving (non-secret) half of Go's exact string
 * concatenation for the Kong entrypoint (`start.go:588-601`): only the
 * `custom_nginx.template` heredoc and the final `docker-entrypoint.sh` exec
 * line — `LEGACY_KONG_ENTRYPOINT_HEAD + nginxTemplate + "\nEOF\n"`. The other
 * three heredocs Go's version chains ahead of this one (`kong.yml`, the TLS
 * cert, the TLS key) no longer travel through this script at all — see this
 * module's header comment for why (`secretFiles`, CWE-214/522).
 */
export function legacyBuildKongEntrypointScript(nginxTemplate: string): string {
  return LEGACY_KONG_ENTRYPOINT_HEAD + nginxTemplate + "\nEOF\n";
}

export interface LegacyKongContainerSpecInput {
  /** `config.api.kong_image`, already resolved/pulled by the caller. */
  readonly image: string;
  /** `legacyServiceContainerName("kong", projectId)` — Go's `utils.KongId`. */
  readonly containerName: string;
  /** Go's `utils.NetId` — the shared Docker network every `start` container joins. */
  readonly networkId: string;
  /** `config.hostname`, post-override — the `kongConfig.ApiHost` template field (currently unreferenced by `kong.yml`'s body, but still required to match Go's struct exactly). */
  readonly apiHost: string;
  /**
   * `config.api.port`, post-`SUPABASE_API_PORT`-override — used for the
   * `kongConfig.ApiPort` template field, `KONG_PORT_MAPS`, and (alongside
   * {@link apiTlsEnabled}) the published host port.
   */
  readonly apiPort: number;
  /** `config.api.tls.enabled`, post-override — selects the published container port (`8443` vs `8000`, `start.go:560-563`). */
  readonly apiTlsEnabled: boolean;
  /**
   * `Config.Api.Tls.CertContent` as a string. NOT empty-by-default: Go's
   * `NewConfig` seeds this with the embedded default cert
   * (`pkg/config/config.go:452-455`, `LEGACY_KONG_LOCAL_TLS_CERT`) and only
   * `Validate` overwrites it from `api.tls.cert_path` when TLS is enabled AND
   * both `cert_path`/`key_path` are configured — the caller must pass the
   * embedded default here otherwise, matching Kong's own unconditional write
   * of this field to `/home/kong/localhost.crt` (`start.go:585-601`).
   */
  readonly tlsCertContent: string;
  /** `Config.Api.Tls.KeyContent` as a string — see {@link tlsCertContent} for the same embedded-default requirement. */
  readonly tlsKeyContent: string;
  /** The four already-generated API keys `BearerToken`/`QueryToken` are built from — see {@link legacyBuildKongBearerToken}/{@link legacyBuildKongQueryToken}. */
  readonly apiKeys: LegacyKongApiKeys;
  /** Go's `utils.GotrueId` — GoTrue's own container name. */
  readonly gotrueId: string;
  /** Go's `utils.RestId` — PostgREST's own container name. */
  readonly restId: string;
  /**
   * Go's `Config.Realtime.TenantId` (`start.go:492`) — NOT Realtime's
   * container name/id. Realtime is reachable under this same value because
   * it is ALSO Realtime's own network alias (`utils.RealtimeAliases =
   * ["realtime", Config.Realtime.TenantId]`), so `kong.yml`'s `url:
   * http://{{ .RealtimeId }}:4000/...` resolves via that alias, not via
   * `legacyServiceContainerName("realtime", projectId)`.
   */
  readonly realtimeTenantId: string;
  /** Go's `utils.StorageId` — Storage's own container name. */
  readonly storageId: string;
  /** Go's `utils.StudioId` — Studio's own container name. */
  readonly studioId: string;
  /** Go's `utils.PgmetaId` — pg-meta's own container name. */
  readonly pgmetaId: string;
  /** Go's `utils.EdgeRuntimeId` — Edge Runtime's own container name. */
  readonly edgeRuntimeId: string;
  /** Go's `utils.LogflareId` — Logflare's own container name. */
  readonly logflareId: string;
  /** Go's `utils.PoolerId` — Supavisor's own container name. */
  readonly poolerId: string;
  /**
   * `envOrDefault("KONG_NGINX_WORKER_PROCESSES", "1")` — already resolved by
   * the caller via {@link legacyResolveKongNginxWorkerProcesses}, keeping
   * this builder a pure function of its `input`.
   */
  readonly nginxWorkerProcesses: string;
  /**
   * Go's `workdir` (`os.Getwd()` in `run()`, `start.go:308`) — used to
   * resolve any relative {@link emailTemplateMounts} `contentPath` to an
   * absolute host path (`filepath.Abs`, `start.go:531-538`).
   */
  readonly workdir: string;
  /**
   * Every `config.auth.email.template.*`/enabled `config.auth.email.notification.*`
   * entry the caller has already gathered (`start.go:544-558`) — see
   * {@link LegacyKongEmailTemplateMount}'s doc comment for the notification
   * `id` suffixing/filtering the caller owns. Defaults to `[]` (no email
   * template mounts).
   */
  readonly emailTemplateMounts?: ReadonlyArray<LegacyKongEmailTemplateMount>;
}

/**
 * Assembles Kong's {@link LegacyStartContainerSpec}. Pure — no Effect or
 * ambient I/O — matching every other `start`-service builder in this
 * directory.
 */
export function legacyBuildKongContainerSpec(
  input: LegacyKongContainerSpecInput,
): LegacyStartContainerSpec {
  const kongYml = legacyRenderStartKongYml({
    gotrueId: input.gotrueId,
    restId: input.restId,
    realtimeId: input.realtimeTenantId,
    storageId: input.storageId,
    studioId: input.studioId,
    pgmetaId: input.pgmetaId,
    edgeRuntimeId: input.edgeRuntimeId,
    logflareId: input.logflareId,
    poolerId: input.poolerId,
    apiHost: input.apiHost,
    apiPort: input.apiPort,
    bearerToken: legacyBuildKongBearerToken(input.apiKeys),
    queryToken: legacyBuildKongQueryToken(input.apiKeys),
  });

  const binds = (input.emailTemplateMounts ?? [])
    .map((mount) => legacyBuildKongEmailTemplateBind(mount, input.workdir))
    .filter((bind): bind is string => bind !== undefined);

  const dockerPort = input.apiTlsEnabled ? 8443 : 8000;

  return {
    image: input.image,
    containerName: input.containerName,
    env: {
      KONG_DATABASE: "off",
      KONG_DECLARATIVE_CONFIG: "/home/kong/kong.yml",
      // Ref: https://github.com/supabase/cli/issues/14
      KONG_DNS_ORDER: "LAST,A,CNAME",
      KONG_PLUGINS: "request-transformer,cors",
      KONG_PORT_MAPS: `${input.apiPort}:8000`,
      // Ref: https://github.com/Kong/kong/issues/3974#issuecomment-482105126
      KONG_NGINX_PROXY_PROXY_BUFFER_SIZE: "160k",
      KONG_NGINX_PROXY_PROXY_BUFFERS: "64 160k",
      KONG_NGINX_WORKER_PROCESSES: input.nginxWorkerProcesses,
      KONG_SSL_CERT: "/home/kong/localhost.crt",
      KONG_SSL_CERT_KEY: "/home/kong/localhost.key",
    },
    entrypoint: "sh",
    cmd: ["-c", legacyBuildKongEntrypointScript(LEGACY_START_CUSTOM_NGINX_TEMPLATE)],
    secretFiles: [
      { containerPath: "/home/kong/kong.yml", content: kongYml },
      { containerPath: "/home/kong/localhost.crt", content: input.tlsCertContent },
      { containerPath: "/home/kong/localhost.key", content: input.tlsKeyContent },
    ],
    binds,
    ports: [{ hostPort: String(input.apiPort), containerPort: String(dockerPort) }],
    exposedPorts: [
      { containerPort: "8000" },
      { containerPort: "8443" },
      { containerPort: String(LEGACY_KONG_NGINX_TEMPLATE_SERVER_PORT) },
    ],
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    networkAliases: LEGACY_KONG_NETWORK_ALIASES,
    labels: {},
  };
}
