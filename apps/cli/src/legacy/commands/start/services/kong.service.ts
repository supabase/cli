/**
 * Kong container spec builder, gated on
 * `!isContainerExcluded(config.api.kong_image, excluded)` (Kong has no
 * `enabled` flag of its own — it is the stack's mandatory gateway) — see
 * `legacy-service-catalog.ts`'s `kong` entry (`excludeKey: "kong"`). Gating and
 * image resolution/pre-pull are the caller's job (a future `start.handler.ts`);
 * this module only assembles the container spec once the caller has already
 * decided to start it, matching `docker-create-args.ts`'s "image already
 * resolved/pulled" contract.
 *
 * How `kong.yml`/`custom_nginx.template`/the TLS cert+key get injected into
 * the container: a single `sh -c` entrypoint script could chain FOUR
 * `cat <<'EOF' > <path> && \` heredocs (joined by shell line-continuation
 * into one logical command line), landing all four bodies — including
 * `kong.yml`'s embedded service-role-key-derived bearer/query tokens and the
 * TLS private key — directly in the container's own `Cmd`. THIS PORT SHELLS
 * OUT to a real `docker create`, where that `Cmd` string would become a
 * subprocess's own argv and leak via `ps aux`/`/proc/<pid>/cmdline`
 * (CWE-214/522), so it deliberately diverges here: `kong.yml` (the
 * service-role key) and the TLS cert/key (the highest-value secret — a
 * private key) travel via {@link LegacyStartContainerSpec.secretFiles}
 * instead — a short-lived HOST temp file, mode `0644` (world-readable —
 * Kong's image runs its process as uid 100 `kong`, a non-root user, and
 * `docker cp`'s tar transfer preserves the host file's mode verbatim, so
 * `0600` would make it unreadable in-container; see
 * `legacyCopyStartSecretFileIntoContainer`'s doc comment), `docker cp`'d
 * straight into the container at the exact fixed paths
 * `KONG_DECLARATIVE_CONFIG`/`KONG_SSL_CERT`/`KONG_SSL_CERT_KEY` already
 * reference — and never appear in this process's own argv. Only
 * `custom_nginx.template`, which carries no secret content, still travels
 * via the heredoc entrypoint script.
 *
 * The TLS cert/key `secretFiles` entries are still ALWAYS present — never a
 * conditional bind — because `KONG_SSL_CERT`/`KONG_SSL_CERT_KEY` reference
 * fixed in-container paths unconditionally. Their content is never empty
 * either: the default config seeds `Api.Tls.{CertContent,KeyContent}` with
 * the embedded default localhost cert/key, and only overwrites them from
 * disk when TLS is enabled AND both `cert_path`/`key_path` are configured —
 * see {@link LegacyKongContainerSpecInput.tlsCertContent}'s doc comment.
 * {@link legacyBuildKongEntrypointScript} reproduces the remaining
 * `custom_nginx.template` heredoc + exec line byte-for-byte; see its doc
 * comment for the exact shell mechanics.
 *
 * Kong mints no JWTs of its own: `BearerToken`/`QueryToken` are Kong
 * `request-transformer`/lua expression STRINGS built from the four
 * already-generated API keys (`secretKey`/`serviceRoleKey`/`publishableKey`/
 * `anonKey` — see `legacy-local-config-values.ts`'s `LegacyLocalConfigValues`,
 * which already resolves all four). {@link legacyBuildKongBearerToken}/
 * {@link legacyBuildKongQueryToken} build those two strings; nothing in this
 * module calls `legacyGenerateGoJwt` itself.
 */

import * as nodePath from "node:path";
import { legacyResolveNotificationContentPath } from "../../../shared/legacy-config-validate.ts";

import type { LegacyStartContainerSpec } from "../../../shared/db-bootstrap/docker-create-args.ts";
import { legacyEnvOrDefault } from "../lib/legacy-env-or-default.ts";
import { legacyRenderStartKongYml } from "../lib/template-render.ts";
import { LEGACY_START_CUSTOM_NGINX_TEMPLATE } from "../templates/custom_nginx.template.ts";

/** The Kong network aliases — a fixed, non-configurable constant. */
const LEGACY_KONG_NETWORK_ALIASES = ["kong", "api.supabase.internal"];

/** The fixed in-container directory email template mounts land in. */
const LEGACY_KONG_NGINX_EMAIL_TEMPLATE_DIR = "/home/kong/templates/email";

/** The fixed port `custom_nginx.template`'s `email_templates` server listens on. */
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
 * The Kong bearer token: a Kong `request-transformer` lua expression, NOT a
 * JWT — forwards a caller's own `Bearer sb_...` Authorization header
 * verbatim, otherwise maps a matching `apikey` header to the corresponding
 * `Bearer <key>` value, falling back to echoing `apikey` as-is.
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
 * The Kong query token: the same mapping as {@link legacyBuildKongBearerToken},
 * applied to the `apikey` query parameter instead of a header, and without
 * the `Bearer sb_...` passthrough branch (there is no equivalent "already a
 * query-string bearer" case).
 */
export function legacyBuildKongQueryToken(apiKeys: LegacyKongApiKeys): string {
  return (
    `$((query_params.apikey == '${apiKeys.secretKey}' and '${apiKeys.serviceRoleKey}') ` +
    `or (query_params.apikey == '${apiKeys.publishableKey}' and '${apiKeys.anonKey}') ` +
    `or query_params.apikey)`
  );
}

/**
 * `KONG_NGINX_WORKER_PROCESSES`, env-or-default: the operator's own shell
 * value wins when set (e.g. `KONG_NGINX_WORKER_PROCESSES=auto` for one
 * worker per CPU core), otherwise a default of a single worker to minimize
 * local-stack memory usage (Ref: supabase/cli#1271). `projectEnvValues` is
 * the merged (dotenv + ambient shell, ambient-wins) view, so a
 * `KONG_NGINX_WORKER_PROCESSES` set only in a project dotenv file (not the
 * ambient shell) is honored too, matching Storage's identical `VECTOR_*`-env
 * handling (`storage.service.ts`). Kept separate from
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
   * The raw `config.auth.email.template` key for a template mount, or
   * `<key>_notification` for an enabled `config.auth.email.notification`
   * entry — the caller is responsible for that suffixing and for filtering
   * notifications down to `enabled` ones; this module only derives the
   * per-mount path.
   */
  readonly id: string;
  /** `tmpl.ContentPath` — empty means "not configured" (no bind emitted). */
  readonly contentPath: string;
  /**
   * Notification mounts resolve through
   * `legacyResolveNotificationContentPath` so the bind targets the same file
   * config validation accepted (including the legacy `supabase/`-relative
   * fallback); template mounts keep plain workdir resolution.
   */
  readonly notification?: boolean;
}

/**
 * Resolves `contentPath` to an absolute HOST path (relative to the process's
 * own working directory, the same project-root base used while validating
 * `content_path`), joins it onto the fixed in-container email-template
 * directory as `<id><ext-of-hostPath>` (POSIX — the container is always
 * Linux regardless of the host OS, hence `nodePath.posix.join`, not the
 * platform-dependent `nodePath.join`), and formats the `rw` bind. Returns
 * `undefined` for an empty `contentPath` (no bind appended).
 */
export function legacyBuildKongEmailTemplateBind(
  mount: LegacyKongEmailTemplateMount,
  workdir: string,
): string | undefined {
  if (mount.contentPath.length === 0) return undefined;
  const hostPath = mount.notification
    ? legacyResolveNotificationContentPath(workdir, mount.contentPath)
    : nodePath.isAbsolute(mount.contentPath)
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
 * Builds the surviving (non-secret) half of the Kong entrypoint: only the
 * `custom_nginx.template` heredoc and the final `docker-entrypoint.sh` exec
 * line — `LEGACY_KONG_ENTRYPOINT_HEAD + nginxTemplate + "\nEOF\n"`. The
 * other three heredocs that could otherwise chain ahead of this one
 * (`kong.yml`, the TLS cert, the TLS key) don't travel through this script
 * at all — see this module's header comment for why (`secretFiles`,
 * CWE-214/522).
 */
export function legacyBuildKongEntrypointScript(nginxTemplate: string): string {
  return LEGACY_KONG_ENTRYPOINT_HEAD + nginxTemplate + "\nEOF\n";
}

export interface LegacyKongContainerSpecInput {
  /** `config.api.kong_image`, already resolved/pulled by the caller. */
  readonly image: string;
  /** `legacyServiceContainerName("kong", projectId)`. */
  readonly containerName: string;
  /** The shared Docker network every `start` container joins. */
  readonly networkId: string;
  /** `config.hostname`, post-override — the `kongConfig.ApiHost` template field (currently unreferenced by `kong.yml`'s body, but still a required template field). */
  readonly apiHost: string;
  /**
   * `config.api.port`, post-`SUPABASE_API_PORT`-override — used for the
   * `kongConfig.ApiPort` template field, `KONG_PORT_MAPS`, and (alongside
   * {@link apiTlsEnabled}) the published host port.
   */
  readonly apiPort: number;
  /** `config.api.tls.enabled`, post-override — selects the published container port (`8443` vs `8000`). */
  readonly apiTlsEnabled: boolean;
  /**
   * The resolved TLS cert content. NOT empty-by-default: the default config
   * seeds this with the embedded default cert (`LEGACY_KONG_LOCAL_TLS_CERT`)
   * and only config validation overwrites it from `api.tls.cert_path` when
   * TLS is enabled AND both `cert_path`/`key_path` are configured — the
   * caller must pass the embedded default here otherwise, since this field
   * is always written to `/home/kong/localhost.crt` unconditionally.
   */
  readonly tlsCertContent: string;
  /** The resolved TLS key content — see {@link tlsCertContent} for the same embedded-default requirement. */
  readonly tlsKeyContent: string;
  /** The four already-generated API keys `BearerToken`/`QueryToken` are built from — see {@link legacyBuildKongBearerToken}/{@link legacyBuildKongQueryToken}. */
  readonly apiKeys: LegacyKongApiKeys;
  /** GoTrue's own container name. */
  readonly gotrueId: string;
  /** PostgREST's own container name. */
  readonly restId: string;
  /**
   * `config.realtime.tenant_id` — NOT Realtime's container name/id.
   * Realtime is reachable under this same value because it is ALSO
   * Realtime's own network alias (`["realtime", tenantId]`), so
   * `kong.yml`'s `url: http://{{ .RealtimeId }}:4000/...` resolves via that
   * alias, not via `legacyServiceContainerName("realtime", projectId)`.
   */
  readonly realtimeTenantId: string;
  /** Storage's own container name. */
  readonly storageId: string;
  /** Studio's own container name. */
  readonly studioId: string;
  /** pg-meta's own container name. */
  readonly pgmetaId: string;
  /** Edge Runtime's own container name. */
  readonly edgeRuntimeId: string;
  /** Logflare's own container name. */
  readonly logflareId: string;
  /** Supavisor's own container name. */
  readonly poolerId: string;
  /**
   * `envOrDefault("KONG_NGINX_WORKER_PROCESSES", "1")` — already resolved by
   * the caller via {@link legacyResolveKongNginxWorkerProcesses}, keeping
   * this builder a pure function of its `input`.
   */
  readonly nginxWorkerProcesses: string;
  /**
   * `LegacyCliConfig.workdir` — used to resolve any relative
   * {@link emailTemplateMounts} `contentPath` to an absolute host path.
   */
  readonly workdir: string;
  /**
   * Every `config.auth.email.template.*`/enabled
   * `config.auth.email.notification.*` entry the caller has already
   * gathered — see {@link LegacyKongEmailTemplateMount}'s doc comment for
   * the notification `id` suffixing/filtering the caller owns. Defaults to
   * `[]` (no email template mounts).
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
