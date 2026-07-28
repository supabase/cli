/**
 * Connection-error classification and rendering ported from Go's
 * `internal/utils/connect.go` and pgconn's `connectError` (`errors.go:60-77`).
 * Used by the container-level pooler fallback (`db dump --linked`) to decide
 * whether a failed pg_dump/pg container was an IPv6 connectivity failure that
 * warrants retrying through the IPv4 transaction pooler, and by the connection
 * layer to render connect failures with Go's `host=… user=… database=…` detail.
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
// Node's dial-failure shape (`connect ENETUNREACH 2600:…:5432`). The port may be
// followed by whitespace, end-of-string, or a closing paren — the connect-failure
// message renders the driver cause parenthesized (pgconn `dial error (…)` form).
const NODE_ENETUNREACH_PATTERN = /\benetunreach\s+([0-9a-fA-F:]+):\d+(?:[\s)]|$)/i;

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
}

/**
 * Flatten an error's `cause` chain into a single searchable string of every
 * nested `message` and `code`. The `@effect/sql` `SqlError` wraps the
 * node-postgres / node `net` driver error on its `cause`; a multi-address dial
 * wraps an `AggregateError` whose `errors[]` carry the per-IP `ECONNREFUSED` /
 * `ENETUNREACH` system errors — an aggregate node contributes NOTHING itself
 * and only its LAST child is visited, because that is the attempt pgconn
 * surfaces: its fallback loop overwrites the error on every attempt so only the
 * last one survives (`pgconn.go:171-203`), and Go's `SetConnectSuggestion`
 * classifies exactly that `err.Error()` string (`connect.go:317`). The parent's
 * own fields must be skipped: node's `aggregateErrors` copies `errors[0].code`
 * onto the aggregate itself (`lib/internal/errors.js`, Bun matches), so reading
 * them would blame an abandoned first attempt. Including the `code` strings of
 * the visited nodes lets the matcher key off node's `ECONNREFUSED` the way Go
 * keys off pgconn's `connect: connection refused`.
 */
function legacyCollectConnectErrorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > 8 || typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    const errors = Reflect.get(node, "errors");
    if (Array.isArray(errors) && errors.length > 0) {
      visit(errors[errors.length - 1], depth + 1);
      return;
    }
    const message = Reflect.get(node, "message");
    if (typeof message === "string") parts.push(message);
    const code = Reflect.get(node, "code");
    if (typeof code === "string") parts.push(code);
    visit(Reflect.get(node, "cause"), depth + 1);
  };
  visit(error, 0);
  return parts.join("\n");
}

/**
 * The connection identity pgconn embeds in its `connectError` text
 * (`errors.go:66-68`): the config-level (primary) host, user, and database —
 * never the password.
 */
export interface LegacyConnectFailureTarget {
  readonly host: string;
  readonly user: string;
  readonly database: string;
}

/**
 * Walk to the deepest underlying driver error: unwrap `cause` chains (the
 * `@effect/sql` `SqlError` exposes its `ConnectionError` reason as `cause`, and
 * the reason exposes the node-postgres error the same way) and descend into the
 * LAST entry of an `AggregateError`'s `errors[]` — pgconn's multi-address
 * fallback loop likewise surfaces the last attempt's error
 * (`pgconn.go:159-192`).
 */
function legacyDeepestConnectCause(error: unknown): unknown {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8; depth++) {
    if (typeof current !== "object" || current === null || seen.has(current)) break;
    seen.add(current);
    const errors = Reflect.get(current, "errors");
    if (Array.isArray(errors) && errors.length > 0) {
      current = errors[errors.length - 1];
      continue;
    }
    const cause = Reflect.get(current, "cause");
    if (typeof cause !== "object" || cause === null) break;
    current = cause;
  }
  return current;
}

// Node/Bun errno codes raised while dialing the server — pgconn wraps the
// equivalent net.Dial failures as `dial error (…)` (`pgconn.go:276`).
const LEGACY_DIAL_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
]);
// The complete documented Node/OpenSSL X509 certificate-verification code
// family (Node tls docs "X509 certificate error codes", OpenSSL's
// `X509_verify_cert_error` set), complemented by node's ERR_TLS_*/ERR_SSL_*
// prefixes at the use site. pgconn stages by connection PHASE — ANY `startTLS`
// failure becomes `tls error (…)` (`pgconn.go:283-289`) — but node exposes no
// phase marker, so the full code family is the proxy. These strings are unique
// to TLS-layer verification: server SQLSTATEs and dial/DNS `E…` errnos are
// classified by earlier branches.
const LEGACY_TLS_ERROR_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CRL_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
  "CRL_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "OUT_OF_MEM",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REVOKED",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "INVALID_PURPOSE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "HOSTNAME_MISMATCH",
]);
// node-postgres' own message when the server answers `N` to SSLRequest
// (`pg/lib/connection.js`); pgconn: `tls error (server refused TLS connection)`.
const LEGACY_SERVER_REFUSED_SSL = "The server does not support SSL connections";
// Node/Bun's TLS-socket message when the server accepts SSLRequest but closes
// the socket before the handshake completes (node `lib/_tls_wrap.js`
// `onConnectEnd`; Bun emits the same text for both FIN and RST). Phase-specific
// by construction — only ever raised pre-secure-connection — so it maps to
// pgconn's startTLS stage (`tls error (…)`, `pgconn.go:283-289`). Its code is
// ECONNRESET, deliberately absent from LEGACY_DIAL_ERROR_CODES: a raw
// post-handshake `read ECONNRESET` is not phase-specific and stays verbatim.
const LEGACY_TLS_DISCONNECT_MESSAGE =
  "Client network socket disconnected before secure TLS connection was established";
// A Postgres SQLSTATE is exactly five uppercase alphanumerics. Combined with the
// `severity` field this identifies a node-postgres `DatabaseError` (a server
// ErrorResponse), never a node system error (whose codes are longer `E…` names).
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/**
 * Whether a driver error `code` is a Postgres SQLSTATE (a server ErrorResponse)
 * rather than a node system errno (`ECONNRESET`, …). Shared by the connect-cause
 * renderer below and the driver layer's exec-error mapping, which both need to
 * distinguish server errors from socket/driver failures.
 */
export const legacyIsSqlState = (code: string): boolean => SQLSTATE_PATTERN.test(code);

/**
 * Render the underlying driver failure the way pgconn stages its
 * `connectError.msg` (`server error` / `hostname resolving error` /
 * `dial error` / `tls error`, each with the cause parenthesized —
 * `errors.go:66-72`). A server ErrorResponse reproduces pgconn's `PgError`
 * rendering byte-for-byte (`Severity: Message (SQLSTATE Code)`, `errors.go:51`);
 * for the other stages the parenthesized text is the node driver's own message,
 * which cannot byte-match libpq/pgconn wording (e.g. node's
 * `connect ECONNREFUSED 1.2.3.4:5432` vs Go's
 * `dial tcp 1.2.3.4:5432: connect: connection refused`). An unrecognized cause
 * (e.g. node-postgres' `Connection terminated unexpectedly`, where pgconn would
 * say `failed to receive message (unexpected EOF)`) is rendered verbatim rather
 * than guessing a stage.
 *
 * Known stage-label caveat: pgconn labels by auth PHASE, which node-postgres
 * does not expose — a wrong password over SCRAM arrives mid-SASL, so Go renders
 * `failed SASL auth (FATAL: password authentication failed … (SQLSTATE 28P01))`
 * (`pgconn.go:359`) where this renders `server error (…)` with the identical
 * inner `PgError` bytes. The suggestion classifier keys off the inner text, so
 * the `SUPABASE_DB_PASSWORD` hint fires identically either way.
 */
function legacyConnectCauseDetail(cause: unknown): string {
  if (typeof cause !== "object" || cause === null) return String(cause);
  const message = Reflect.get(cause, "message");
  const code = Reflect.get(cause, "code");
  const severity = Reflect.get(cause, "severity");
  const syscall = Reflect.get(cause, "syscall");
  const text =
    typeof message === "string" && message.length > 0
      ? message
      : typeof code === "string"
        ? code
        : String(cause);
  if (typeof severity === "string" && typeof code === "string" && legacyIsSqlState(code)) {
    return `server error (${severity}: ${text} (SQLSTATE ${code}))`;
  }
  if (syscall === "getaddrinfo" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `hostname resolving error (${text})`;
  }
  if (syscall === "connect" || (typeof code === "string" && LEGACY_DIAL_ERROR_CODES.has(code))) {
    return `dial error (${text})`;
  }
  if (
    text === LEGACY_SERVER_REFUSED_SSL ||
    text === LEGACY_TLS_DISCONNECT_MESSAGE ||
    (typeof code === "string" &&
      (LEGACY_TLS_ERROR_CODES.has(code) ||
        code.startsWith("ERR_TLS") ||
        code.startsWith("ERR_SSL")))
  ) {
    return `tls error (${text})`;
  }
  return text;
}

/**
 * Port of pgconn's `connectError.Error()` (`errors.go:66-72`), the inner text of
 * Go's `failed to connect to postgres: %w` wrap (`pkg/pgxv5/connect.go:33`):
 * `` failed to connect to `host=… user=… database=…`: <staged driver cause> ``.
 * Callers pass the connection config (pgconn embeds the config-level identity,
 * `errors.go:66-68`) and the raw failure — either the `@effect/sql` `SqlError`
 * from the pooled connect probe or the bare node-postgres error from the raw
 * client, both unwrapped by {@link legacyDeepestConnectCause}.
 */
export function legacyConnectFailureMessage(
  target: LegacyConnectFailureTarget,
  error: unknown,
): string {
  const detail = legacyConnectCauseDetail(legacyDeepestConnectCause(error));
  return `failed to connect to \`host=${target.host} user=${target.user} database=${target.database}\`: ${detail}`;
}

// Dial errno codes that mean the target address itself is unreachable. Combined
// with an IPv6 `address` they are node's equivalents of Go's IPv6-connectivity
// texts: ENETUNREACH → `network is unreachable`, EHOSTUNREACH → `no route to
// host`, EADDRNOTAVAIL → `cannot assign requested address` (`connect.go:204-223`).
const LEGACY_IPV6_DIAL_CODES = new Set(["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"]);

/**
 * Whether the error chain carries a node dial failure whose errno + `address`
 * fields identify an unreachable IPv6 target. This is the structured complement
 * to {@link legacyIsIPv6ConnectivityError}: node system errors carry the dialed
 * address as a field (`connect EHOSTUNREACH 2600:…:5432` has `code` and
 * `address`), whereas Go's classifier reads the same facts out of pgconn's
 * message text. Narrower than `legacyIsIPv6ConnectivityErrorCause` — it never
 * treats `ENOTFOUND` (a plain DNS miss, e.g. a typo'd host) as IPv6, matching
 * Go, where a failed lookup renders `hostname resolving error` and sets no
 * suggestion. Use THIS one for the connect suggestion; the container-level
 * pooler fallback keeps the broader `legacyIsIPv6ConnectivityErrorCause`.
 * Like {@link legacyDeepestConnectCause}, an `AggregateError` descends into its
 * LAST child only — the attempt pgconn surfaces (`pgconn.go:171-203`) and the
 * one Go's classifier reads (`connect.go:317`). Depth-bounded recursion (no
 * `seen` set): a pathological cause cycle re-walks at most 8 levels, which is
 * cheap and cannot loop.
 */
function legacyHasIPv6DialCause(error: unknown, depth = 0): boolean {
  if (depth > 8 || typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  const address = Reflect.get(error, "address");
  if (
    typeof code === "string" &&
    LEGACY_IPV6_DIAL_CODES.has(code) &&
    typeof address === "string" &&
    isIPv6(address)
  ) {
    return true;
  }
  const errors = Reflect.get(error, "errors");
  if (Array.isArray(errors) && errors.length > 0) {
    return legacyHasIPv6DialCause(errors[errors.length - 1], depth + 1);
  }
  return legacyHasIPv6DialCause(Reflect.get(error, "cause"), depth + 1);
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
 *
 * Sourcing note: the rendered message ({@link legacyConnectFailureMessage}) and
 * this classifier inspect the SAME surfaced attempt, as Go guarantees by
 * construction — pgconn's fallback loop overwrites its error on every attempt so
 * only the last one survives (`pgconn.go:171-203`), and `SetConnectSuggestion`
 * classifies exactly that rendered `err.Error()` string (`connect.go:317`). The
 * collectors above therefore descend into only the LAST aggregate child, the
 * same attempt {@link legacyDeepestConnectCause} surfaces for rendering, so the
 * displayed cause and the suggestion can never disagree.
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
  // Wrong password (Go: "SCRAM exchange: Wrong password" / "failed SASL auth";
  // node-postgres surfaces the server's `28P01` "password authentication failed").
  if (
    text.includes("SCRAM exchange: Wrong password") ||
    text.includes("failed SASL auth") ||
    text.includes("password authentication failed")
  ) {
    return LEGACY_SUGGEST_ENV_VAR;
  }
  // Go: `isIPv6ConnectivityError` on the pgconn text. node system errors carry
  // the dialed address as a structured field instead of libpq's parenthesized
  // literal, so also consult the errno + `address` classifier.
  if (legacyIsIPv6ConnectivityError(text) || legacyHasIPv6DialCause(error)) {
    return legacyIpv6Suggestion();
  }
  // connect: no route to host / Tenant or user not found → wrong profile.
  // node's "no route to host" is `connect EHOSTUNREACH <ip>:<port>`; an IPv6
  // EHOSTUNREACH was already captured by the IPv6 branch above, mirroring Go's
  // branch order ("Assumes IPv6 check has been performed before this").
  if (
    text.includes("no route to host") ||
    text.includes("EHOSTUNREACH") ||
    text.includes("Tenant or user not found")
  ) {
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
 * Used by the container-level pooler fallback (`gen types` / `db dump`); the
 * connect-suggestion path uses the narrower `legacyHasIPv6DialCause` instead,
 * which must not treat a DNS miss as IPv6.
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
