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

/**
 * Go's `utils.SuggestEnvVar` (`internal/utils/connect.go:191`): the hint shown when
 * a connection fails on password authentication, pointing users at the
 * `SUPABASE_DB_PASSWORD` env var.
 */
export const LEGACY_SUGGEST_ENV_VAR =
  "Connect to your database by setting the env var correctly: SUPABASE_DB_PASSWORD";

/** Context the connect-suggestion needs but cannot derive from the error alone. */
export interface LegacyConnectSuggestionContext {
  /** Active profile's dashboard URL (Go's `CurrentProfile.DashboardURL`). */
  readonly dashboardUrl: string;
  /** Active profile name (Go's `CurrentProfile.Name`). */
  readonly profileName: string;
  /** Whether `--debug` is set (Go's `viper.GetBool("DEBUG")`). */
  readonly debug: boolean;
}

/**
 * Flatten an error's `cause` chain and any `AggregateError.errors` into a single
 * searchable string of every nested `message` and `code`. The `@effect/sql`
 * `SqlError` wraps the node-postgres / node `net` driver error on its `cause`; a
 * multi-address dial wraps an `AggregateError` whose `errors[]` carry the per-IP
 * `ECONNREFUSED` / `ENETUNREACH` system errors. Including the `code` strings lets
 * the matcher key off node's `ECONNREFUSED` the way Go keys off pgconn's
 * `connect: connection refused`.
 */
function legacyCollectConnectErrorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > 8 || typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    const message = Reflect.get(node, "message");
    if (typeof message === "string") parts.push(message);
    const code = Reflect.get(node, "code");
    if (typeof code === "string") parts.push(code);
    visit(Reflect.get(node, "cause"), depth + 1);
    const errors = Reflect.get(node, "errors");
    if (Array.isArray(errors)) for (const child of errors) visit(child, depth + 1);
  };
  visit(error, 0);
  return parts.join("\n");
}

/**
 * Port of Go's `SetConnectSuggestion` (`internal/utils/connect.go:313-335`): map a
 * Postgres connect failure to an actionable hint that replaces the generic
 * "Try rerunning the command with --debug" suggestion. Go matches `pgconn`'s
 * error text; this matches the equivalent node-postgres / node `net` driver text
 * and codes (e.g. `ECONNREFUSED` for `connect: connection refused`) gathered from
 * the `SqlError` cause/aggregate chain. The branch order mirrors Go's `if/else if`.
 * Returns `undefined` when no specific suggestion applies (the caller then falls
 * back to the generic suggestion, like Go leaving `CmdSuggestion` empty).
 */
export function legacyConnectSuggestion(
  error: unknown,
  ctx: LegacyConnectSuggestionContext,
): string | undefined {
  const text = legacyCollectConnectErrorText(error);
  // connect: connection refused / Address not in tenant allow_list → network restrictions.
  if (
    text.includes("ECONNREFUSED") ||
    text.includes("connection refused") ||
    text.includes("Address not in tenant allow_list")
  ) {
    return `Make sure your local IP is allowed in Network Restrictions and Network Bans.\n${ctx.dashboardUrl}/project/_/database/settings`;
  }
  // SSL connection is required (only under --debug, which disables TLS).
  if (text.includes("SSL connection is required") && ctx.debug) {
    return "SSL connection is not supported with --debug flag";
  }
  // Wrong password (Go: "SCRAM exchange: Wrong password" / "failed SASL auth";
  // node-postgres surfaces the server's `28P01` "password authentication failed").
  if (
    text.includes("SCRAM exchange: Wrong password") ||
    text.includes("failed SASL auth") ||
    text.includes("password authentication failed")
  ) {
    return LEGACY_SUGGEST_ENV_VAR;
  }
  if (legacyIsIPv6ConnectivityError(text)) {
    return legacyIpv6Suggestion();
  }
  // no route to host / Tenant or user not found → wrong profile.
  if (text.includes("no route to host") || text.includes("Tenant or user not found")) {
    return `Make sure your project exists on profile: ${ctx.profileName}`;
  }
  return undefined;
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
