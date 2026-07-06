/**
 * Connection-error classification ported from Go's `internal/utils/connect.go`.
 * Used by the container-level pooler fallback (`db dump --linked`) to decide
 * whether a failed pg_dump/pg container was an IPv6 connectivity failure that
 * warrants retrying through the IPv4 transaction pooler.
 */

import { isIPv6 } from "node:net";

import { legacyAqua } from "./legacy-colors.ts";

/**
 * Go's generic `ipv6Suggestion()` (`internal/utils/connect.go:223-231`): the
 * command-agnostic hint shown when a direct connection fails because the host is
 * IPv6-only, pointing users at the IPv4 transaction pooler via `--db-url`. Go's
 * `SetConnectSuggestion` sets this on the dump failure when the captured container
 * stderr classifies as an IPv6 error (and, on the no-fallback path, may further
 * enrich it with the project's actual pooler URL via `SuggestIPv6Pooler`). Byte-exact
 * to Go, including the `Aqua`-coloured `--db-url`.
 */
export function legacyIpv6Suggestion(): string {
  return (
    "Your network does not support IPv6, which is required for direct connections to the database.\n" +
    `Retry with your project's IPv4 transaction pooler connection string via ${legacyAqua("--db-url")}.\n` +
    "You can copy it from the dashboard under Connect > Transaction pooler."
  );
}

// Go's `ipv6LiteralPattern` (`connect.go:181`): an IPv6 address in brackets
// (Go dial form) or parens (libpq form). Run against the original-case message.
const IPV6_LITERAL_PATTERN = /(?:\[[0-9a-fA-F:]+\]|\([0-9a-fA-F:]+\))/;
const NODE_ENETUNREACH_PATTERN = /\benetunreach\s+([0-9a-fA-F:]+):\d+(?:\s|$)/i;

/**
 * Port of Go's `isIPv6ConnectivityError` (`connect.go:189-208`). Lower-cases the
 * message and matches the getaddrinfo / dial failures that mean the host is
 * IPv6-only and unreachable from this environment. "no route to host" and
 * "cannot assign requested address" only count when an IPv6 literal is present
 * (they are otherwise ambiguous).
 */
export function legacyIsIPv6ConnectivityError(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes("address family for hostname not supported")) return true;
  if (lower.includes("no address associated with hostname")) return true;
  if (lower.includes("network is unreachable")) return true;
  const nodeEnetunreachMatch = NODE_ENETUNREACH_PATTERN.exec(message);
  if (nodeEnetunreachMatch?.[1] !== undefined) return isIPv6(nodeEnetunreachMatch[1]);
  if (lower.includes("no route to host") || lower.includes("cannot assign requested address")) {
    return IPV6_LITERAL_PATTERN.test(message);
  }
  return false;
}

function hasStringCode(error: unknown): error is {
  readonly code: string;
  readonly address?: unknown;
} {
  return (
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
  );
}

/**
 * Classifies Node socket/getaddrinfo causes that carry errno-style `code` fields.
 * `ENOTFOUND` is intentionally broader than Go's text classifier (it can include
 * typo'd hosts); callers must combine this with a direct `db.<ref>` host gate.
 */
export function legacyIsIPv6ConnectivityErrorCause(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some((cause) => legacyIsIPv6ConnectivityErrorCause(cause));
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    error.cause !== undefined &&
    legacyIsIPv6ConnectivityErrorCause(error.cause)
  ) {
    return true;
  }

  if (hasStringCode(error)) {
    switch (error.code) {
      case "ENETUNREACH":
      case "ENOTFOUND":
        return true;
      case "EHOSTUNREACH":
      case "EADDRNOTAVAIL":
        return typeof error.address === "string" && isIPv6(error.address);
      case "ECONNREFUSED":
      case "ENOENT":
      case "ETIMEDOUT":
        return false;
      default:
        break;
    }
  }

  return legacyIsIPv6ConnectivityError(error instanceof Error ? error.message : String(error));
}
