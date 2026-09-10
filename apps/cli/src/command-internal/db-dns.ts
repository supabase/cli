import * as net from "node:net";
import { Duration, Effect } from "effect";

import { DbConnectError } from "./db-connection.errors.ts";

// Cloudflare DNS-over-HTTPS JSON endpoint + record types (IANA DNS parameters).
const CF_DOH_URL = "https://1.1.1.1/dns-query";
const TYPE_A = 1; // IPv4
const TYPE_AAAA = 28; // IPv6
const DOH_TIMEOUT = Duration.seconds(10);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extracts every A/AAAA address from a Cloudflare DNS-over-HTTPS JSON response so the caller
 * can retry each in turn. Throws when no valid IP is present.
 */
export function parseResolvedIps(payload: unknown, host: string): string[] {
  const answers = isRecord(payload) && Array.isArray(payload["Answer"]) ? payload["Answer"] : [];
  const resolved: string[] = [];
  for (const answer of answers) {
    if (
      isRecord(answer) &&
      (answer["type"] === TYPE_A || answer["type"] === TYPE_AAAA) &&
      typeof answer["data"] === "string" &&
      // Require a well-formed IP, not just a non-empty string: this value flows into
      // `buildConnectionUrl`, so a tampered DoH answer like `1.2.3.4@attacker.com` could
      // otherwise become the URL authority and redirect the credentialed connection
      // (CWE-20/CWE-350).
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
 * Resolves `host` to its IPs via Cloudflare DNS-over-HTTPS, used when `--dns-resolver https` is
 * set. A host that is already an IP literal is returned unchanged.
 *
 * Returns every resolved address so the caller can retry each in turn. The caller dials a
 * returned IP but keeps the original hostname for the TLS `servername`, so certificate
 * verification still targets the hostname.
 */
export function resolveHostsOverHttps(host: string): Effect.Effect<string[], DbConnectError> {
  if (net.isIP(host) !== 0) return Effect.succeed([host]);
  return Effect.tryPromise({
    try: (signal) =>
      fetch(`${CF_DOH_URL}?name=${encodeURIComponent(host)}`, {
        headers: { accept: "application/dns-json" },
        signal,
      }).then(async (response) => {
        if (response.status !== 200) {
          throw new Error(`unexpected DNS query status ${response.status}`);
        }
        return parseResolvedIps(await response.json(), host);
      }),
    catch: (cause) =>
      new DbConnectError({
        message: `failed to resolve ${host} via DNS-over-HTTPS: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: DOH_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new DbConnectError({
            message: `failed to resolve ${host} via DNS-over-HTTPS: timed out`,
          }),
        ),
    }),
  );
}
