import * as net from "node:net";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { LegacyDnsResolverFlag } from "../../shared/legacy/global-flags.ts";
import { LegacyDbConnectError } from "./legacy-db-connection.errors.ts";
import { legacyResolveHostsOverHttps } from "./legacy-db-dns.ts";

/**
 * The result of transforming an original HTTPS request URL so the TCP
 * connection dials the resolved IP directly while TLS still targets the
 * original hostname — mirroring Go's `withFallbackDNS` dial-context hook
 * (`apps/cli-go/internal/utils/api.go:85-104`).
 */
export interface LegacyDohRequestShape {
  /** The rewritten URL with the IP literal as authority. */
  readonly url: string;
  /** The original hostname; used as the TLS SNI value and `Host` header. */
  readonly serverName: string;
  /** The `Host` header value: the original hostname (+ port when non-standard). */
  readonly hostHeader: string;
}

/**
 * Pure URL-rewrite helper. Swaps the authority of `originalUrl` to the
 * resolved IP address while keeping the scheme, path, query, and fragment
 * intact. IPv6 addresses are bracketed (`[::1]`) per RFC 2732.
 *
 * When `originalUrl`'s host is already an IP literal no rewrite is needed;
 * callers should check `net.isIP(host) !== 0` and short-circuit before
 * calling this function. If `resolvedIp` is not a valid IP this function
 * throws — callers are expected to only pass values from `parseResolvedIps`,
 * which already enforces `net.isIP !== 0`.
 *
 * @param originalUrl - Fully qualified HTTPS URL, e.g. `https://api.supabase.com/v1/projects`.
 * @param resolvedIp  - IPv4 or IPv6 address from a DoH resolution.
 * @returns `{ url, serverName, hostHeader }` for building the rewritten fetch call.
 */
export function buildDohRequest(originalUrl: string, resolvedIp: string): LegacyDohRequestShape {
  const parsed = new URL(originalUrl);
  // URL.hostname may include brackets for IPv6 in Bun (e.g. "[::1]"). Callers
  // pass a non-IP hostname, so we just record the raw value and strip any
  // brackets for serverName (TLS SNI must be the bare hostname, never bracketed).
  const rawHostname = parsed.hostname;
  const originalHost =
    rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;
  const portSuffix = parsed.port !== "" ? `:${parsed.port}` : ""; // preserve explicit port

  // Bracket IPv6 in the URL authority (RFC 2732). Bun requires brackets when
  // assigning an IPv6 address to URL.hostname.
  const ipAuthority = net.isIPv6(resolvedIp) ? `[${resolvedIp}]` : resolvedIp;
  parsed.hostname = ipAuthority;

  return {
    url: parsed.toString(),
    serverName: originalHost,
    hostHeader: `${originalHost}${portSuffix}`,
  };
}

/**
 * The bare callable fetch signature. This is the call part of
 * `typeof globalThis.fetch` minus the Bun-specific `preconnect` namespace
 * member, so tests can pass a plain function as `innerFetch` without having to
 * stub `preconnect`.
 */
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Options for `legacyDohFetch`. All fields are injectable for testing.
 */
export interface LegacyDohFetchOptions {
  /** The `--dns-resolver` flag value ("native" | "https"). */
  readonly dnsResolver: "native" | "https";
  /**
   * DoH resolver — returns `string[]` of IPs for `host`. Defaults to
   * `legacyResolveHostsOverHttps` (Cloudflare 1.1.1.1), which is itself an IP
   * literal, so no bootstrap recursion.
   */
  readonly resolver?: (host: string) => Effect.Effect<string[], LegacyDbConnectError>;
  /**
   * The underlying fetch implementation to delegate to. Defaults to
   * `globalThis.fetch`.
   */
  readonly innerFetch?: FetchFn;
}

/**
 * Produces a custom `fetch` implementation that DNS-over-HTTPS-resolves the
 * request hostname before dialing, then passes `tls.serverName` so Bun
 * validates the TLS certificate against the original hostname — not the IP.
 *
 * Mirrors Go's `withFallbackDNS` transport hook
 * (`apps/cli-go/internal/utils/api.go:85-104`): use the first resolved IP
 * (Go's `ip[0]`), keep the Host header, keep TLS targeting the original name.
 *
 * Returns a standard `fetch` function suitable for use as
 * `FetchHttpClient.Fetch`'s context value.
 *
 * @param opts - Configuration including `dnsResolver`, optional `resolver` fake, and optional `innerFetch` fake.
 */
export function legacyDohFetch(opts: LegacyDohFetchOptions): typeof globalThis.fetch {
  const { dnsResolver, resolver = legacyResolveHostsOverHttps } = opts;
  const innerFetch: FetchFn = opts.innerFetch ?? globalThis.fetch;

  const fetchImpl: FetchFn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    // Normalise to string URL — same as what FetchHttpClient passes.
    const originalUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(originalUrl);
    // URL.hostname returns bracketed IPv6 (e.g. "[::1]") in Bun. Strip brackets
    // before the isIP check so net.isIP correctly identifies IPv6 literals.
    const rawHostname = parsed.hostname;
    const host =
      rawHostname.startsWith("[") && rawHostname.endsWith("]")
        ? rawHostname.slice(1, -1)
        : rawHostname;

    // Short-circuit 1: not DoH mode or already an IP literal.
    if (dnsResolver !== "https" || net.isIP(host) !== 0) {
      return innerFetch(input, init);
    }

    // DoH-resolve and take the first IP (Go's ip[0]).
    const ips = await Effect.runPromise(resolver(host));
    const firstIp = ips[0];
    if (firstIp === undefined) {
      // resolver guarantees non-empty; this is a safety net.
      return innerFetch(input, init);
    }

    const { url, serverName, hostHeader } = buildDohRequest(originalUrl, firstIp);

    // `BunFetchRequestInit` is Bun's global fetch-init type; it extends the
    // standard `RequestInit` with `tls`. Bun's fetch honors `tls.serverName`:
    // the TLS handshake sends this as the SNI extension and validates the peer
    // certificate against it — not against the IP in the URL. Evidence:
    // `fetch('https://104.16.133.229/', { tls: { serverName: 'cloudflare.com' } })`
    // returned HTTP 403 (cert validated OK against 'cloudflare.com'). CWE-350
    // guard: cert validation never falls back to the raw IP even though the URL
    // authority is an IP literal.
    const rewrittenInit: BunFetchRequestInit = {
      ...init,
      headers: {
        ...init?.headers,
        Host: hostHeader,
      },
      tls: { serverName },
    };

    return innerFetch(url, rewrittenInit);
  };

  // `FetchHttpClient.Fetch` holds a `typeof globalThis.fetch`, which in Bun
  // carries a `preconnect` namespace member alongside the call signature.
  // Attach the real `preconnect` so the override is a structurally complete
  // `fetch` — no cast needed. `preconnect` is a Bun-only perf hint and is never
  // invoked by Effect's FetchHttpClient.
  return Object.assign(fetchImpl, { preconnect: globalThis.fetch.preconnect });
}

/**
 * Effect layer that overrides `FetchHttpClient.Fetch` with the DoH-aware
 * fetch implementation when `--dns-resolver https` is active.
 *
 * Provide this layer alongside `FetchHttpClient.layer` at every Management
 * API HTTP transport site so raw GETs (advisors, suggest-upgrade, sso raw,
 * linked-project cache) and the typed platform API client both honour the flag.
 *
 * When `--dns-resolver native` (the default), the layer installs the standard
 * `globalThis.fetch` unchanged — no overhead or behaviour change.
 */
export const legacyDohFetchLayer = Layer.effect(
  FetchHttpClient.Fetch,
  Effect.gen(function* () {
    const dnsResolver = yield* LegacyDnsResolverFlag;
    return legacyDohFetch({ dnsResolver });
  }),
);
