/**
 * Connection-error classification ported from Go's `internal/utils/connect.go`.
 * Used by the container-level pooler fallback (`db dump --linked`) to decide
 * whether a failed pg_dump/pg container was an IPv6 connectivity failure that
 * warrants retrying through the IPv4 transaction pooler.
 */

// Go's `ipv6LiteralPattern` (`connect.go:181`): an IPv6 address in brackets
// (Go dial form) or parens (libpq form). Run against the original-case message.
const IPV6_LITERAL_PATTERN = /(?:\[[0-9a-fA-F:]+\]|\([0-9a-fA-F:]+\))/;

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
  if (lower.includes("no route to host") || lower.includes("cannot assign requested address")) {
    return IPV6_LITERAL_PATTERN.test(message);
  }
  return false;
}
