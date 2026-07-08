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
