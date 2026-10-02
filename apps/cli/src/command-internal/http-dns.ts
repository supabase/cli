import * as net from "node:net";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { DnsResolverFlag } from "./global-flags.ts";
import { DbConnectError } from "./db-connection.errors.ts";
import { resolveHostsOverHttps } from "./db-dns.ts";

/**
 * The result of rewriting an HTTPS request URL so the TCP connection dials
 * the resolved IP directly while TLS still targets the original hostname.
 */
export interface DohRequestShape {
  /** The rewritten URL with the IP literal as authority. */
  readonly url: string;
  /** The original hostname; used as the TLS SNI value and `Host` header. */
  readonly serverName: string;
  /** The `Host` header value: the original hostname (+ port when non-standard). */
  readonly hostHeader: string;
}

/**
 * Swaps the authority of `originalUrl` to `resolvedIp` while keeping the
 * scheme, path, query, and fragment intact. IPv6 addresses are bracketed
 * (`[::1]`) per RFC 2732.
 *
 * Callers should short-circuit before calling this when the host is already
 * an IP literal. Throws if `resolvedIp` is not a valid IP.
 *
 * @param originalUrl - Fully qualified HTTPS URL, e.g. `https://api.supabase.com/v1/projects`.
 * @param resolvedIp - IPv4 or IPv6 address from a DoH resolution.
 * @returns `{ url, serverName, hostHeader }` for building the rewritten fetch call.
 */
export function buildDohRequest(originalUrl: string, resolvedIp: string): DohRequestShape {
  const parsed = new URL(originalUrl);
  // TLS SNI must be the bare hostname; strip the brackets Bun adds for IPv6.
  const rawHostname = parsed.hostname;
  const originalHost =
    rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;
  const portSuffix = parsed.port !== "" ? `:${parsed.port}` : "";

  // Bun requires brackets when assigning an IPv6 address to URL.hostname.
  const ipAuthority = net.isIPv6(resolvedIp) ? `[${resolvedIp}]` : resolvedIp;
  parsed.hostname = ipAuthority;

  return {
    url: parsed.toString(),
    serverName: originalHost,
    hostHeader: `${originalHost}${portSuffix}`,
  };
}

/**
 * The call part of `typeof globalThis.fetch`, without the Bun-specific
 * `preconnect` namespace member, so tests can pass a plain function as
 * `innerFetch` without stubbing `preconnect`.
 */
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Options for `dohFetch`. All fields are injectable for testing. */
export interface DohFetchOptions {
  /** The `--dns-resolver` flag value ("native" | "https"). */
  readonly dnsResolver: "native" | "https";
  /**
   * DoH resolver — returns `string[]` of IPs for `host`. Defaults to
   * `resolveHostsOverHttps` (Cloudflare 1.1.1.1), which is itself an IP
   * literal, so no bootstrap recursion.
   */
  readonly resolver?: (host: string) => Effect.Effect<string[], DbConnectError>;
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
 * Returns a standard `fetch` function suitable for use as
 * `FetchHttpClient.Fetch`'s context value.
 *
 * @param opts - Configuration including `dnsResolver`, optional `resolver` fake, and optional `innerFetch` fake.
 */
export function dohFetch(opts: DohFetchOptions): typeof globalThis.fetch {
  const { dnsResolver, resolver = resolveHostsOverHttps } = opts;
  const innerFetch: FetchFn = opts.innerFetch ?? globalThis.fetch;

  const fetchImpl: FetchFn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const originalUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(originalUrl);
    // Strip Bun's IPv6 brackets (e.g. "[::1]") so net.isIP identifies the literal correctly.
    const rawHostname = parsed.hostname;
    const host =
      rawHostname.startsWith("[") && rawHostname.endsWith("]")
        ? rawHostname.slice(1, -1)
        : rawHostname;

    if (dnsResolver !== "https" || net.isIP(host) !== 0) {
      return innerFetch(input, init);
    }

    // The request's abort signal must reach the lookup too, or an abort during
    // resolution leaves the resolver fiber running until the DoH server answers.
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const ips = await Effect.runPromise(resolver(host), { signal: signal ?? undefined });
    const firstIp = ips[0];
    if (firstIp === undefined) {
      // resolver guarantees a non-empty result; this is a safety net.
      return innerFetch(input, init);
    }

    const { url, serverName, hostHeader } = buildDohRequest(originalUrl, firstIp);

    // `init.headers` may be a plain record, a WHATWG `Headers` instance
    // (supabase-js), or an entries array; spreading a `Headers` instance yields
    // zero entries, so rebuild through the constructor. A `Request` input with
    // no `init.headers` carries its headers on the request itself.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set("Host", hostHeader);
    // Bun's fetch sends `tls.serverName` as the SNI extension and validates
    // the peer certificate against it, not against the IP used as the URL
    // authority.
    const rewrittenInit: BunFetchRequestInit = {
      ...init,
      headers,
      tls: { serverName },
    };

    return innerFetch(url, rewrittenInit);
  };

  // `typeof globalThis.fetch` includes Bun's `preconnect` member; attach the
  // real one so this override satisfies that type without a cast.
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
export const dohFetchLayer = Layer.effect(
  FetchHttpClient.Fetch,
  Effect.gen(function* () {
    const dnsResolver = yield* DnsResolverFlag;
    return dohFetch({ dnsResolver });
  }),
);
