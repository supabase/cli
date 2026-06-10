import * as net from "node:net";
import { Duration, Effect } from "effect";

import { LegacyDbConnectError } from "./legacy-db-connection.errors.ts";

// Cloudflare DNS-over-HTTPS JSON endpoint + record types (IANA DNS parameters).
// Mirrors Go's `utils.FallbackLookupIP` (`apps/cli-go/internal/utils/api.go:37`).
const CF_DOH_URL = "https://1.1.1.1/dns-query";
const TYPE_A = 1; // IPv4
const TYPE_AAAA = 28; // IPv6
const DOH_TIMEOUT = Duration.seconds(10);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extract the first A/AAAA address from a Cloudflare DNS-over-HTTPS JSON
 * response. Mirrors Go's `FallbackLookupIP`: scan `Answer` for the first entry
 * whose `type` is A (1) or AAAA (28) and return its `data`. Throws (Go returns
 * an error) when no valid IP is present.
 */
export function parseFirstResolvedIp(payload: unknown, host: string): string {
  const answers = isRecord(payload) && Array.isArray(payload["Answer"]) ? payload["Answer"] : [];
  for (const answer of answers) {
    if (
      isRecord(answer) &&
      (answer["type"] === TYPE_A || answer["type"] === TYPE_AAAA) &&
      typeof answer["data"] === "string" &&
      answer["data"].length > 0
    ) {
      return answer["data"];
    }
  }
  throw new Error(`failed to locate valid IP for ${host}`);
}

/**
 * Resolve `host` to an IP via Cloudflare DNS-over-HTTPS, the fallback resolver
 * Go installs when `--dns-resolver https` is set and the native netgo resolver
 * is blocked (`utils.FallbackLookupIP`). A host that is already an IP literal is
 * returned unchanged (matching Go's `net.ParseIP` short-circuit).
 *
 * The caller dials the returned IP but keeps the original hostname for the TLS
 * `servername`, so certificate verification still targets the hostname.
 */
export function legacyResolveHostOverHttps(
  host: string,
): Effect.Effect<string, LegacyDbConnectError> {
  if (net.isIP(host) !== 0) return Effect.succeed(host);
  return Effect.tryPromise({
    try: (signal) =>
      fetch(`${CF_DOH_URL}?name=${encodeURIComponent(host)}`, {
        headers: { accept: "application/dns-json" },
        signal,
      }).then(async (response) => {
        if (response.status !== 200) {
          throw new Error(`unexpected DNS query status ${response.status}`);
        }
        return parseFirstResolvedIp(await response.json(), host);
      }),
    catch: (cause) =>
      new LegacyDbConnectError({
        message: `failed to resolve ${host} via DNS-over-HTTPS: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      }),
  }).pipe(
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
