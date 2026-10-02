import { goUrlParse } from "./storage-url.ts";

/**
 * Derives the local API URL: an explicit `api.external_url` wins, otherwise
 * `<scheme>://<host>:<port>` from `api.tls.enabled` and `api.port`. Hoisted here
 * because `storage-credentials.ts` and `local-config-values.ts` both need it.
 */
export function resolveApiExternalUrl(
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
  // Brackets an IPv6 host, e.g. `[::1]:5432`.
  const hostPort = hostname.includes(":")
    ? `[${hostname}]:${config.port}`
    : `${hostname}:${config.port}`;
  return `${scheme}://${hostPort}`;
}

/**
 * Rewrites `studio.api_url` to the resolved API external URL when its host is empty or
 * matches the bare local hostname with no port (the default-config case). An explicit
 * non-matching host, or a host:port pair, is left untouched.
 */
export function resolveStudioApiUrl(
  rawApiUrl: string,
  hostname: string,
  apiExternalUrl: string,
): string {
  const { host } = goUrlParse(rawApiUrl);
  return host === "" || host === hostname ? apiExternalUrl : rawApiUrl;
}
