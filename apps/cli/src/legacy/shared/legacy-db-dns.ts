import * as net from "node:net";
import { Duration, Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { LegacyDbConnectError } from "./legacy-db-connection.errors.ts";

// Cloudflare DNS-over-HTTPS JSON endpoint + record types (IANA DNS parameters).
// Mirrors `utils.FallbackLookupIP`.
const CF_DOH_URL = "https://1.1.1.1/dns-query";
const TYPE_A = 1; // IPv4
const TYPE_AAAA = 28; // IPv6
const DOH_TIMEOUT = Duration.seconds(10);

const DnsAnswerSchema = Schema.Struct({
  type: Schema.Finite,
  data: Schema.String,
});
const DnsResponseSchema = Schema.Struct({
  Answer: Schema.optional(Schema.Array(DnsAnswerSchema)),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extract the first A/AAAA address from a Cloudflare DNS-over-HTTPS JSON
 * response. Mirrors `FallbackLookupIP`, which returns the full `[]string`
 * of `Answer` entries whose `type` is A (1) or AAAA (28) so pgconn's
 * `expandWithIPs` can try each in turn. Throws (Go returns an error) when no
 * valid IP is present.
 */
export function parseResolvedIps(payload: unknown, host: string): string[] {
  const answers = isRecord(payload) && Array.isArray(payload["Answer"]) ? payload["Answer"] : [];
  const resolved: string[] = [];
  for (const answer of answers) {
    if (
      isRecord(answer) &&
      (answer["type"] === TYPE_A || answer["type"] === TYPE_AAAA) &&
      typeof answer["data"] === "string" &&
      // Require a well-formed IP, not just a non-empty string. Go only ever uses
      // the resolved value as a pgconn `LookupFunc` dial target (an IP); here it
      // also flows into `legacyBuildConnectionUrl`, so a tampered DoH answer like
      // `1.2.3.4@attacker.com` could otherwise become the URL authority and
      // redirect the credentialed connection (CWE-20/CWE-350).
      net.isIP(answer["data"]) !== 0
    ) {
      resolved.push(answer["data"]);
    }
  }
  if (resolved.length === 0) {
    throw new Error(`failed to locate valid IP for ${host}`);
  }
  return resolved;
}

/**
 * Resolve `host` to its IPs via Cloudflare DNS-over-HTTPS, the fallback resolver
 * Go installs when `--dns-resolver https` is set and the native netgo resolver
 * is blocked (`utils.FallbackLookupIP`). A host that is already an IP literal is
 * returned unchanged (matching `net.ParseIP` short-circuit).
 *
 * Returns **all** resolved addresses so the caller can retry each (Go hands the
 * full list to pgconn, which dials them in order). The caller dials a returned
 * IP but keeps the original hostname for the TLS `servername`, so certificate
 * verification still targets the hostname.
 */
export function legacyResolveHostsOverHttps(
  host: string,
): Effect.Effect<string[], LegacyDbConnectError> {
  if (net.isIP(host) !== 0) return Effect.succeed([host]);
  return Effect.gen(function* () {
    const fetch = yield* FetchHttpClient.Fetch;
    const { response, payload } = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${CF_DOH_URL}?name=${encodeURIComponent(host)}`, {
          headers: { accept: "application/dns-json" },
          signal,
        }).then((response) =>
          response.status === 200
            ? response.json().then((payload) => ({ response, payload }))
            : { response, payload: undefined },
        ),
      catch: (cause) =>
        new LegacyDbConnectError({
          message: `failed to resolve ${host} via DNS-over-HTTPS: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        }),
    });
    if (response.status !== 200) {
      return yield* new LegacyDbConnectError({
        message: `failed to resolve ${host} via DNS-over-HTTPS: unexpected DNS query status ${response.status}`,
      });
    }
    const decoded = yield* Schema.decodeUnknownEffect(DnsResponseSchema)(payload).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyDbConnectError({
            message: `failed to resolve ${host} via DNS-over-HTTPS: invalid response: ${String(cause)}`,
          }),
      ),
    );
    return yield* Effect.try({
      try: () => parseResolvedIps(decoded, host),
      catch: (cause) =>
        new LegacyDbConnectError({
          message: `failed to resolve ${host} via DNS-over-HTTPS: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        }),
    });
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError((cause) =>
      cause instanceof LegacyDbConnectError
        ? cause
        : new LegacyDbConnectError({
            message: `failed to resolve ${host} via DNS-over-HTTPS: ${String(cause)}`,
          }),
    ),
    Effect.timeoutOrElse({
      duration: DOH_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new LegacyDbConnectError({
            message: `failed to resolve ${host} via DNS-over-HTTPS: timed out`,
          }),
        ),
    }),
  );
}
