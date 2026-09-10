/**
 * Connection-error classification and rendering ported from the established
 * connect helpers and pgconn's `connectError`.
 * Used by the container-level pooler fallback (`db dump --linked`) to decide
 * whether a failed pg_dump/pg container was an IPv6 connectivity failure that
 * warrants retrying through the IPv4 transaction pooler, and by the connection
 * layer to render connect failures with `host=… user=… database=…` detail.
 */

import { isIPv6 } from "node:net";

import { aqua } from "./colors.ts";

/**
 * Command-agnostic hint shown when a direct connection fails because the host is IPv6-only,
 * pointing users at the IPv4 transaction pooler via `--db-url`. Reproduces the established
 * message text exactly, including the aqua-coloured `--db-url`.
 */
export function ipv6Suggestion(): string {
  return (
    "Your network does not support IPv6, which is required for direct connections to the database.\n" +
    `Retry with your project's IPv4 transaction pooler connection string via ${aqua("--db-url")}.\n` +
    "You can copy it from the dashboard under Connect > Transaction pooler."
  );
}

// An IPv6 address in brackets (dial form) or parens (libpq form). Run against the
// original-case message.
const IPV6_LITERAL_PATTERN = /(?:\[[0-9a-fA-F:]+\]|\([0-9a-fA-F:]+\))/;
// Node's dial-failure shape (`connect ENETUNREACH 2600:…:5432`). The port may be
// followed by whitespace, end-of-string, or a closing paren — the connect-failure
// message renders the driver cause parenthesized (pgconn `dial error (…)` form).
const NODE_ENETUNREACH_PATTERN = /\benetunreach\s+([0-9a-fA-F:]+):\d+(?:[\s)]|$)/i;

/**
 * Lower-cases the message and matches the getaddrinfo/dial failures that mean the host is
 * IPv6-only and unreachable from this environment. "no route to host" and "cannot assign
 * requested address" only count when an IPv6 literal is present (otherwise ambiguous).
 */
export function isIPv6ConnectivityError(message: string): boolean {
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
 * Hint shown when a connection fails on password authentication, pointing users at the
 * `SUPABASE_DB_PASSWORD` env var.
 */
export const SUGGEST_ENV_VAR =
  "Connect to your database by setting the env var correctly: SUPABASE_DB_PASSWORD";

/**
 * Shown instead of the remote-only "Network Restrictions" hint when `ctx.isLocal` is true — a
 * refused `--local` connection (Docker/Postgres not running) needs a different fix than an
 * actual network-restricted remote connection. See `connectSuggestion`.
 */
export const SUGGEST_LOCAL_STACK = "Make sure Docker is running, then run: supabase start";

/**
 * Remote-only "Network Restrictions" hint, shown for a connection refused or blocked by IP
 * allow-listing. Shared by both the always-remote `Address not in tenant allow_list` branch
 * and the non-local `ECONNREFUSED`/`connection refused` branch in `connectSuggestion`.
 */
function suggestNetworkRestrictions(dashboardUrl: string): string {
  return `Make sure your local IP is allowed in Network Restrictions and Network Bans.\n${dashboardUrl}/project/_/database/settings`;
}

/** Context the connect-suggestion needs but cannot derive from the error alone. */
export interface ConnectSuggestionContext {
  /** Active profile's dashboard URL. */
  readonly dashboardUrl: string;
  /** Active profile name. */
  readonly profileName: string;
}

/**
 * Flattens an error's `cause` chain into a single searchable string of every nested `message`
 * and `code`. The `@effect/sql` `SqlError` wraps the node-postgres/node `net` driver error on
 * its `cause`; a multi-address dial wraps an `AggregateError` whose `errors[]` carry the
 * per-IP `ECONNREFUSED`/`ENETUNREACH` system errors — an aggregate node contributes nothing
 * itself and only its last child is visited, since pgconn's own fallback loop overwrites its
 * error on every attempt so only the last one survives. The parent's own fields are skipped:
 * node's `aggregateErrors` copies `errors[0].code` onto the aggregate itself (`lib/internal/
 * errors.js`, Bun matches), so reading them would blame an abandoned first attempt.
 */
function collectConnectErrorText(error: unknown): string {
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
 * The connection identity embedded in the established connect-failure text: the config-level
 * (primary) host, user, and database — never the password.
 */
export interface ConnectFailureTarget {
  readonly host: string;
  readonly user: string;
  readonly database: string;
}

/**
 * Walks to the deepest underlying driver error: unwraps `cause` chains (the `@effect/sql`
 * `SqlError` exposes its `ConnectionError` reason as `cause`, and the reason exposes the
 * node-postgres error the same way) and descends into the last entry of an `AggregateError`'s
 * `errors[]` — pgconn's multi-address fallback loop likewise surfaces the last attempt's error.
 */
function deepestConnectCause(error: unknown): unknown {
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
// equivalent net.Dial failures as `dial error (…)`.
const DIAL_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
]);
// Connect-timeout failures that carry no errno `code`, matched by their exact
// driver text: node-postgres' client connect timeout (`pg/lib/client.js`), its
// pool acquire timeout (`pg/lib/pool.js`), and this layer's own probe timeout
// (`acquireProbedPool`). All three correspond to a connect-timeout firing.
const CONNECT_TIMEOUT_MESSAGES = new Set([
  "Connection timed out",
  "timeout expired",
  "timeout exceeded when trying to connect",
]);

/**
 * Whether a connect failure is a dial-level error — refused, timed out, or unreachable —
 * rather than a server, auth, TLS, or config error. Sets `DbConnectError.retryable`, which
 * the fresh-db bootstrap's connect retry keys off (`db-setup.ts`).
 */
export function isDialFailure(error: unknown): boolean {
  const cause = deepestConnectCause(error);
  if (hasStringCode(cause) && DIAL_ERROR_CODES.has(cause.code)) return true;
  const message = typeof cause === "object" && cause !== null ? Reflect.get(cause, "message") : "";
  return typeof message === "string" && CONNECT_TIMEOUT_MESSAGES.has(message);
}
// The complete documented Node/OpenSSL X509 certificate-verification code
// family (Node tls docs "X509 certificate error codes", OpenSSL's
// `X509_verify_cert_error` set), complemented by node's ERR_TLS_*/ERR_SSL_*
// prefixes at the use site. pgconn stages by connection phase — any `startTLS`
// failure becomes `tls error (…)` — but node exposes no
// phase marker, so the full code family is the proxy. These strings are unique
// to TLS-layer verification: server SQLSTATEs and dial/DNS `E…` errnos are
// classified by earlier branches.
const TLS_ERROR_CODES = new Set([
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
const SERVER_REFUSED_SSL = "The server does not support SSL connections";
// Node/Bun's TLS-socket message when the server accepts SSLRequest but closes
// the socket before the handshake completes (node `lib/_tls_wrap.js`
// `onConnectEnd`; Bun emits the same text for both FIN and RST). Phase-specific
// by construction — only ever raised pre-secure-connection — so it maps to
// pgconn's startTLS stage (`tls error (…)`). Its code is
// ECONNRESET, deliberately absent from DIAL_ERROR_CODES: a raw
// post-handshake `read ECONNRESET` is not phase-specific and stays verbatim.
const TLS_DISCONNECT_MESSAGE =
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
export const isSqlState = (code: string): boolean => SQLSTATE_PATTERN.test(code);

/**
 * Render the underlying driver failure the way pgconn stages its
 * `connectError.msg` (`server error` / `hostname resolving error` /
 * `dial error` / `tls error`, each with the cause parenthesized).
 * A server ErrorResponse reproduces pgconn's `PgError`
 * rendering byte-for-byte (`Severity: Message (SQLSTATE Code)`);
 * for the other stages the parenthesized text is the node driver's own message,
 * which cannot byte-match libpq/pgconn wording (e.g. node's
 * `connect ECONNREFUSED 1.2.3.4:5432` vs
 * `dial tcp 1.2.3.4:5432: connect: connection refused`). An unrecognized cause
 * (e.g. node-postgres' `Connection terminated unexpectedly`, where pgconn would
 * say `failed to receive message (unexpected EOF)`) is rendered verbatim rather
 * than guessing a stage.
 *
 * Known stage-label caveat: pgconn labels by auth phase, which node-postgres
 * does not expose — a wrong password over SCRAM arrives mid-SASL, so pgconn renders
 * `failed SASL auth (FATAL: password authentication failed … (SQLSTATE 28P01))`
 * where this renders `server error (…)` with the identical
 * inner `PgError` bytes. The suggestion classifier keys off the inner text, so
 * the `SUPABASE_DB_PASSWORD` hint fires identically either way.
 */
function connectCauseDetail(cause: unknown): string {
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
  if (typeof severity === "string" && typeof code === "string" && isSqlState(code)) {
    return `server error (${severity}: ${text} (SQLSTATE ${code}))`;
  }
  if (syscall === "getaddrinfo" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `hostname resolving error (${text})`;
  }
  if (syscall === "connect" || (typeof code === "string" && DIAL_ERROR_CODES.has(code))) {
    return `dial error (${text})`;
  }
  if (
    text === SERVER_REFUSED_SSL ||
    text === TLS_DISCONNECT_MESSAGE ||
    (typeof code === "string" &&
      (TLS_ERROR_CODES.has(code) || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL")))
  ) {
    return `tls error (${text})`;
  }
  return text;
}

/**
 * Port of pgconn's `connectError.Error()`, the inner text of
 * `failed to connect to postgres: %w` wrap:
 * `` failed to connect to `host=… user=… database=…`: <staged driver cause> ``.
 * Callers pass the connection config (pgconn embeds the config-level identity)
 * and the raw failure — either the `@effect/sql` `SqlError`
 * from the pooled connect probe or the bare node-postgres error from the raw
 * client, both unwrapped by {@link deepestConnectCause}.
 */
export function connectFailureMessage(target: ConnectFailureTarget, error: unknown): string {
  const detail = connectCauseDetail(deepestConnectCause(error));
  return `failed to connect to \`host=${target.host} user=${target.user} database=${target.database}\`: ${detail}`;
}

// Dial errno codes that mean the target address itself is unreachable. Combined with an IPv6
// `address` they correspond to the textual checks in {@link isIPv6ConnectivityError}:
// ENETUNREACH → "network is unreachable", EHOSTUNREACH → "no route to host", EADDRNOTAVAIL →
// "cannot assign requested address".
const IPV6_DIAL_CODES = new Set(["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"]);

/**
 * Whether the error chain carries a node dial failure whose errno + `address` fields identify
 * an unreachable IPv6 target. This is the structured complement to
 * {@link isIPv6ConnectivityError}: node system errors carry the dialed address as a field
 * (`connect EHOSTUNREACH 2600:…:5432` has `code` and `address`) rather than embedding it in
 * the message text. Narrower than `isIPv6ConnectivityErrorCause` — it never treats `ENOTFOUND`
 * (a plain DNS miss, e.g. a typo'd host) as IPv6. Use this one for the connect suggestion; the
 * container-level pooler fallback keeps the broader `isIPv6ConnectivityErrorCause`. Like
 * {@link deepestConnectCause}, an `AggregateError` descends into only its last child.
 * Depth-bounded recursion (no `seen` set): a pathological cause cycle re-walks at most 8
 * levels, which is cheap and cannot loop.
 */
function hasIPv6DialCause(error: unknown, depth = 0): boolean {
  if (depth > 8 || typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  const address = Reflect.get(error, "address");
  if (
    typeof code === "string" &&
    IPV6_DIAL_CODES.has(code) &&
    typeof address === "string" &&
    isIPv6(address)
  ) {
    return true;
  }
  const errors = Reflect.get(error, "errors");
  if (Array.isArray(errors) && errors.length > 0) {
    return hasIPv6DialCause(errors[errors.length - 1], depth + 1);
  }
  return hasIPv6DialCause(Reflect.get(error, "cause"), depth + 1);
}

/**
 * Maps a Postgres connect failure to an actionable hint that replaces the generic "Try
 * rerunning the command with --debug" suggestion, by matching the node-postgres/node `net`
 * driver text and codes (e.g. `ECONNREFUSED` for a refused connection) gathered from the
 * `SqlError` cause/aggregate chain. Returns `undefined` when no specific suggestion applies.
 *
 * The rendered message ({@link connectFailureMessage}) and this classifier inspect the same
 * surfaced attempt: pgconn's fallback loop keeps only the last error on every attempt, so the
 * collectors above descend into only the last aggregate child too — the displayed cause and
 * the suggestion can never disagree.
 */
export function connectSuggestion(
  error: unknown,
  ctx: ConnectSuggestionContext & { readonly isLocal: boolean },
): string | undefined {
  const text = collectConnectErrorText(error);
  // "Address not in tenant allow_list" only ever comes from the remote pooler rejecting the
  // caller's IP, so it always means network restrictions.
  if (text.includes("Address not in tenant allow_list")) {
    return suggestNetworkRestrictions(ctx.dashboardUrl);
  }
  // Don't send the user to the dashboard's Network Restrictions page for a --local connection.
  if (text.includes("ECONNREFUSED") || text.includes("connection refused")) {
    return ctx.isLocal ? SUGGEST_LOCAL_STACK : suggestNetworkRestrictions(ctx.dashboardUrl);
  }
  if (
    text.includes("SCRAM exchange: Wrong password") ||
    text.includes("failed SASL auth") ||
    text.includes("password authentication failed")
  ) {
    return SUGGEST_ENV_VAR;
  }
  // Node system errors carry the dialed address as a structured field instead of libpq's
  // parenthesized literal, so also consult the errno + `address` classifier.
  if (isIPv6ConnectivityError(text) || hasIPv6DialCause(error)) {
    return ipv6Suggestion();
  }
  // node's "no route to host" is `connect EHOSTUNREACH <ip>:<port>`; an IPv6 EHOSTUNREACH was
  // already captured by the IPv6 branch above, so this only fires for the IPv4 remainder.
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
 * `ENOTFOUND` is intentionally broader than {@link isIPv6ConnectivityError} (it can include
 * typo'd hosts); callers must combine this with a direct `db.<ref>` host gate. Used by the
 * container-level pooler fallback (`gen types`/`db dump`); the connect-suggestion path uses
 * the narrower `hasIPv6DialCause` instead, which must not treat a DNS miss as IPv6.
 */
export function isIPv6ConnectivityErrorCause(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some((cause) => isIPv6ConnectivityErrorCause(cause));
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    error.cause !== undefined &&
    isIPv6ConnectivityErrorCause(error.cause)
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

  return isIPv6ConnectivityError(error instanceof Error ? error.message : String(error));
}
