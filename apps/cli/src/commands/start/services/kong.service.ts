/**
 * Kong container spec builder, gated on
 * `!isContainerExcluded(config.api.kong_image, excluded)` — Kong has no
 * `enabled` flag of its own; it's the stack's mandatory gateway.
 *
 * `kong.yml` and the TLS cert/key travel via
 * {@link StartContainerSpec.secretFiles} (an in-memory `docker cp` tar
 * entry), not the entrypoint script: embedding them in a heredoc would put
 * the service-role key and the TLS private key into the container's own
 * `Cmd`, leaking via `ps aux`/`/proc/<pid>/cmdline` (CWE-214/522). These
 * `secretFiles` entries are always present, since `KONG_SSL_CERT`/
 * `KONG_SSL_CERT_KEY` reference fixed in-container paths unconditionally and
 * their content is never empty (see {@link KongContainerSpecInput.tlsCertContent}).
 * `custom_nginx.template` carries no secret content, so it still travels via
 * {@link buildKongEntrypointScript}'s heredoc, `exec`'d so Kong runs as PID 1.
 *
 * Kong mints no JWTs itself: {@link buildKongBearerToken}/
 * {@link buildKongQueryToken} build lua-expression strings from the four
 * already-generated API keys.
 */

import * as nodePath from "node:path";

import type { StartContainerSpec } from "../../../command-internal/db-bootstrap/docker-create-args.ts";
import { envOrDefault } from "../lib/env-or-default.ts";
import { renderStartKongYml } from "../lib/template-render.ts";
import { START_CUSTOM_NGINX_TEMPLATE } from "../templates/custom_nginx.template.ts";

/** The Kong network aliases — a fixed, non-configurable constant. */
const KONG_NETWORK_ALIASES = ["kong", "api.supabase.internal"];

/** The fixed in-container directory email template mounts land in. */
const KONG_NGINX_EMAIL_TEMPLATE_DIR = "/home/kong/templates/email";

/** The fixed port `custom_nginx.template`'s `email_templates` server listens on. */
const KONG_NGINX_TEMPLATE_SERVER_PORT = 8088;

export interface KongApiKeys {
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
export function buildKongBearerToken(apiKeys: KongApiKeys): string {
  return (
    `$((headers.authorization ~= nil and headers.authorization:sub(1, 10) ~= 'Bearer sb_' and headers.authorization) ` +
    `or (headers.apikey == '${apiKeys.secretKey}' and 'Bearer ${apiKeys.serviceRoleKey}') ` +
    `or (headers.apikey == '${apiKeys.publishableKey}' and 'Bearer ${apiKeys.anonKey}') ` +
    `or headers.apikey)`
  );
}

/**
 * The Kong query token: the same mapping as {@link buildKongBearerToken},
 * applied to the `apikey` query parameter instead of a header, and without
 * the `Bearer sb_...` passthrough branch (there is no equivalent "already a
 * query-string bearer" case).
 */
export function buildKongQueryToken(apiKeys: KongApiKeys): string {
  return (
    `$((query_params.apikey == '${apiKeys.secretKey}' and '${apiKeys.serviceRoleKey}') ` +
    `or (query_params.apikey == '${apiKeys.publishableKey}' and '${apiKeys.anonKey}') ` +
    `or query_params.apikey)`
  );
}

/**
 * `KONG_NGINX_WORKER_PROCESSES`, env-or-default: honors an operator's own
 * value (from a project dotenv file or the ambient shell), defaulting to a
 * single worker to minimize local-stack memory use (supabase/cli#1271). Kept
 * separate from {@link buildKongContainerSpec} so that builder never touches
 * `process.env`.
 */
export function resolveKongNginxWorkerProcesses(
  projectEnvValues?: Readonly<Record<string, string>>,
): string {
  return envOrDefault("KONG_NGINX_WORKER_PROCESSES", "1", projectEnvValues);
}

export interface KongEmailTemplateMount {
  /**
   * The `config.auth.email.template` key, or `<key>_notification` for a
   * notification entry — suffixing and enabled-filtering are the caller's job.
   */
  readonly id: string;
  /**
   * Absolute host path, already resolved, containment-checked, and
   * read-verified by the caller. Omitted entirely (not an empty string) when
   * not configured.
   */
  readonly resolvedPath: string;
  /**
   * `true` for a mount derived from an enabled `auth.email.notification.*`
   * entry — caller-side bookkeeping only; this module doesn't branch on it.
   */
  readonly notification?: boolean;
}

/**
 * Formats one email-template bind mount at
 * `<KONG_NGINX_EMAIL_TEMPLATE_DIR>/<id><ext-of-resolvedPath>`, using the
 * shared `z` SELinux relabel (not the private `Z`) since these are
 * user-owned project files remounted across `start`/`db reset`. Assumes
 * `resolvedPath` is already validated; makes no containment or existence
 * checks of its own.
 */
export function buildKongEmailTemplateBind(mount: KongEmailTemplateMount): string {
  const dockerPath = nodePath.posix.join(
    KONG_NGINX_EMAIL_TEMPLATE_DIR,
    `${mount.id}${nodePath.extname(mount.resolvedPath)}`,
  );
  return `${mount.resolvedPath}:${dockerPath}:rw,z`;
}

const KONG_ENTRYPOINT_HEAD =
  "cat <<'EOF' > /home/kong/custom_nginx.template && \\\n" +
  "exec ./docker-entrypoint.sh kong docker-start --nginx-conf /home/kong/custom_nginx.template\n";

/**
 * Builds the non-secret half of the Kong entrypoint: the
 * `custom_nginx.template` heredoc plus the final `docker-entrypoint.sh` exec
 * line. `kong.yml` and the TLS cert/key travel via `secretFiles` instead —
 * see this module's header.
 */
export function buildKongEntrypointScript(nginxTemplate: string): string {
  return KONG_ENTRYPOINT_HEAD + nginxTemplate + "\nEOF\n";
}

export interface KongContainerSpecInput {
  /** `config.api.kong_image`, already resolved/pulled by the caller. */
  readonly image: string;
  /** `serviceContainerName("kong", projectId)`. */
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
   * The resolved TLS cert content. Never empty: defaults to the embedded
   * cert, only overwritten from `cert_path` when TLS is enabled and both
   * paths are configured. Always written to `/home/kong/localhost.crt`.
   */
  readonly tlsCertContent: string;
  /** The resolved TLS key content — see {@link tlsCertContent} for the same embedded-default requirement. */
  readonly tlsKeyContent: string;
  /** The four already-generated API keys `BearerToken`/`QueryToken` are built from — see {@link buildKongBearerToken}/{@link buildKongQueryToken}. */
  readonly apiKeys: KongApiKeys;
  /** GoTrue's own container name. */
  readonly gotrueId: string;
  /** PostgREST's own container name. */
  readonly restId: string;
  /**
   * `config.realtime.tenant_id`, not Realtime's container name. Realtime is
   * reachable under this value because it's also Realtime's own network alias.
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
  /** Already resolved by the caller via {@link resolveKongNginxWorkerProcesses}, keeping this builder pure. */
  readonly nginxWorkerProcesses: string;
  /**
   * Every `config.auth.email.template.*`/enabled `notification.*` entry the
   * caller has gathered — see {@link KongEmailTemplateMount}. Defaults to `[]`.
   */
  readonly emailTemplateMounts?: ReadonlyArray<KongEmailTemplateMount>;
}

/**
 * Assembles Kong's {@link StartContainerSpec}. Pure — no Effect or
 * ambient I/O — matching every other `start`-service builder in this
 * directory.
 */
export function buildKongContainerSpec(input: KongContainerSpecInput): StartContainerSpec {
  const kongYml = renderStartKongYml({
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
    bearerToken: buildKongBearerToken(input.apiKeys),
    queryToken: buildKongQueryToken(input.apiKeys),
  });

  const binds = (input.emailTemplateMounts ?? []).map((mount) => buildKongEmailTemplateBind(mount));

  const dockerPort = input.apiTlsEnabled ? 8443 : 8000;

  return {
    image: input.image,
    containerName: input.containerName,
    env: {
      KONG_DATABASE: "off",
      KONG_DECLARATIVE_CONFIG: "/home/kong/kong.yml",
      // Ref: https://github.com/supabase/cli/issues/14
      KONG_DNS_ORDER: "LAST,A,CNAME",
      // Ref: https://github.com/supabase/supabase/pull/47846
      KONG_DNS_NOT_FOUND_TTL: "1",
      KONG_DNS_VALID_TTL: "5",
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
    cmd: ["-c", buildKongEntrypointScript(START_CUSTOM_NGINX_TEMPLATE)],
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
      { containerPort: String(KONG_NGINX_TEMPLATE_SERVER_PORT) },
    ],
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    networkAliases: KONG_NETWORK_ALIASES,
    labels: {},
  };
}
