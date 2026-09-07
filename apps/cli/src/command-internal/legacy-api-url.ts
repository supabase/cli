import { legacyGoUrlParse } from "./legacy-storage-url.ts";

/**
 * Local API URL derivation, mirroring Go's `config.go:634-644` + `misc.go:298`:
 * an explicit `api.external_url` wins, otherwise `<scheme>://<host>:<port>`
 * where the scheme follows `api.tls.enabled` and the port is `api.port`.
 * Hoisted here because `legacy-storage-credentials.ts` and
 * `legacy-local-config-values.ts` both need this exact computation.
 */
export function legacyResolveApiExternalUrl(
  config: {
    readonly external_url?: string;
    readonly port: number;
    readonly tls: { readonly enabled: boolean };
  },
  hostname: string,
): string {
  if (config.external_url !== undefined && config.external_url.length > 0) {
    return config.external_url;
  }
  const scheme = config.tls.enabled ? "https" : "http";
  // Go builds host:port with net.JoinHostPort (config.go:636-638), bracketing an
  // IPv6 host.
  const hostPort = hostname.includes(":")
    ? `[${hostname}]:${config.port}`
    : `${hostname}:${config.port}`;
  return `${scheme}://${hostPort}`;
}

/**
 * Go's `Config.Validate` rewrite of `Studio.ApiUrl` (`pkg/config/config.go:1074-1078`):
 * ```go
 * } else if parsed.Host == "" || parsed.Host == c.Hostname {
 *     c.Studio.ApiUrl = c.Api.ExternalUrl
 * }
 * ```
 * Runs as the last step of `Config.Load` (`config.go:882`), so by the time
 * `start` builds Studio's env, `studio.api_url` has already been rewritten to
 * the resolved API external URL (the Kong URL) whenever its host is empty
 * (a relative/schemeless value) or matches the bare local hostname exactly
 * (no port) — which is the default-config case, since `studio.api_url`
 * defaults to `http://127.0.0.1` and `Hostname` defaults to the same
 * `"127.0.0.1"`. An explicit, non-matching host (e.g. a custom domain, or a
 * host:port pair) is left untouched.
 */
export function legacyResolveStudioApiUrl(
  rawApiUrl: string,
  hostname: string,
  apiExternalUrl: string,
): string {
  const { host } = legacyGoUrlParse(rawApiUrl);
  return host === "" || host === hostname ? apiExternalUrl : rawApiUrl;
}
