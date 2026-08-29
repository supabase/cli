import { readFileSync } from "node:fs";
import * as net from "node:net";
import type { ConnectionOptions } from "node:tls";
import { PgClient } from "@effect/sql-pg";
import { Cause, Duration, Effect, Exit, Layer, Option, Scope } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { ConnectionError, SqlError } from "effect/unstable/sql/SqlError";
// `pg` is also `@effect/sql-pg`'s transitive driver; we depend on it directly for
// COPY and extended-protocol migration batches, which `@effect/sql-pg` does not
// expose. Keep the direct `pg` version constraint in package.json aligned with the
// one `@effect/sql-pg` resolves so every path uses the same driver.
import * as Pg from "pg";
import { to as pgCopyTo } from "pg-copy-streams";
import {
  LEGACY_SUGGEST_LOCAL_STACK,
  legacyConnectFailureMessage,
  legacyConnectSuggestion,
  legacyIsDialFailure,
  legacyIsSqlState,
} from "./legacy-connect-errors.ts";
import {
  LegacyDbConnectError,
  LegacyDbCopyError,
  LegacyDbExecError,
} from "./legacy-db-connection.errors.ts";
import {
  type LegacyDbBatchStatement,
  type LegacyDbBatchValue,
  type LegacyDbConnectOptions,
  LegacyDbConnection,
  type LegacyDbSession,
  type LegacyPgConnInput,
} from "./legacy-db-connection.service.ts";
import { legacyResolveHostsOverHttps } from "./legacy-db-dns.ts";

// node-postgres honors `queryMode: "extended"` to force the Parse/Bind/Execute
// protocol (`pg/lib/query.js` `requiresPreparation`), but `@types/pg` doesn't declare
// it. Augment `QueryConfig` so `queryRaw` can request it without an `as` cast.
// pg-pool likewise honors a `verify(client, callback)` option — run for every
// brand-new physical connection before it is handed to a waiting checkout
// (`pg-pool/index.js` `_acquireClient`) — that `@types/pg` doesn't declare either.
// The batch path also needs the real PoolClient `connection` and Connection
// `sendCopyFail` members, which are absent from the public driver types.
declare module "pg" {
  interface QueryConfig {
    queryMode?: "extended" | "simple";
  }
  interface PoolConfig {
    verify?: (client: import("pg").PoolClient, callback: (err?: Error) => void) => void;
  }
  interface PoolClient {
    readonly connection: import("pg").Client["connection"];
  }
  interface Connection {
    sendCopyFail(message: string): void;
  }
}

// Role step-down (`ConnectByConfigStream`): after connecting to a remote database as a
// platform-provisioned login role (`cli_login_*`) or a privileged role
// (`supabase_admin`), run `SET SESSION ROLE postgres` so subsequent statements
// (e.g. `CREATE EXTENSION`) execute as `postgres` rather than the temp role.
const SUPERUSER_ROLE = "supabase_admin";
const CLI_LOGIN_PREFIX = "cli_login_";
const SET_SESSION_ROLE = "SET SESSION ROLE postgres";

// Postgres date / timestamp / timestamptz type OIDs. node-postgres' default parsers
// decode these into a JS `Date`, which is millisecond-resolution and applies the
// local timezone — losing the microseconds that Go's pgx `time.Time` keeps (and
// risking a date shift for `date`). For `db query` we keep the raw Postgres text so
// the formatter can render `time.Time` layout faithfully (microseconds intact).
const PG_DATE_OID = 1082;
const PG_TIMESTAMP_OID = 1114;
const PG_TIMESTAMPTZ_OID = 1184;
const legacyKeepRawText = (value: string): string => value;
/**
 * Per-query node-postgres type config: return the raw text for date/timestamp/
 * timestamptz, delegating every other OID to pg's default (text-mode) parser. Scoped
 * to `queryRaw` (only `db query` uses it), so other code paths keep native `Date`s.
 */
const legacyQueryRawTypes = {
  getTypeParser: (oid: number, format?: "text" | "binary") =>
    oid === PG_DATE_OID || oid === PG_TIMESTAMP_OID || oid === PG_TIMESTAMPTZ_OID
      ? legacyKeepRawText
      : format === undefined
        ? Pg.types.getTypeParser(oid)
        : Pg.types.getTypeParser(oid, format),
};

/**
 * Whether the connecting user requires the `SET SESSION ROLE postgres` step-down.
 * Strips any Supavisor `.{ref}` tenant suffix first (`strings.Split(user, ".")[0]`)
 * before comparing. The step-down `AfterConnect` hook installs **only on the
 * remote path** (`ConnectByConfigStream`); the local path
 * (`ConnectLocalPostgres`) never installs it, regardless of the configured user — so
 * the caller must also gate on `!isLocal` (a local `--db-url` can set any user).
 */
function needsRoleStepDown(user: string): boolean {
  const base = user.split(".")[0] ?? user;
  return base.toLowerCase() === SUPERUSER_ROLE || base.startsWith(CLI_LOGIN_PREFIX);
}

// pgconn terminates the multi-host fallback chain (rather than trying the next
// host) when the server returns an authentication/authorization/catalog/privilege
// error, surfacing it instead of masking it behind a later host. These are the
// SQLSTATEs pgconn
// breaks on; `28000` is gated on the failed attempt having used TLS
// (`fc.TLSConfig != nil`).
const LEGACY_TERMINAL_SQLSTATES = new Set(["28P01", "3D000", "42501"]);
const LEGACY_TLS_GATED_SQLSTATE = "28000";

// Class 08 (connection exception) plus the operator-intervention terminations that
// close the session; 57014 (query_canceled) stays a statement failure.
const LEGACY_SESSION_ENDING_SQLSTATES = new Set(["57P01", "57P02", "57P03", "57P04", "57P05"]);
const legacyIsConnectionEndingSqlState = (code: string): boolean =>
  code.startsWith("08") || LEGACY_SESSION_ENDING_SQLSTATES.has(code);

/**
 * Whether a failed connection attempt should terminate the multi-host fallback
 * chain instead of falling through to the next host. Mirrors pgconn's
 * `ConnectConfig`, which retries fallbacks only for connection-establishment
 * errors and returns server-side auth errors immediately. The `pg` driver attaches
 * the Postgres SQLSTATE as a `code` property on the server error (carried through
 * `@effect/sql`'s `SqlError.cause`), so we walk the `cause` chain looking for one.
 */
export function legacyIsTerminalConnectError(error: unknown, usedTls: boolean): boolean {
  const code = legacyExtractSqlState(error);
  if (code === undefined) return false;
  if (LEGACY_TERMINAL_SQLSTATES.has(code)) return true;
  return code === LEGACY_TLS_GATED_SQLSTATE && usedTls;
}

/**
 * Extracts the Postgres SQLSTATE from a driver error. The `pg` driver attaches the
 * code as a `code` property on the server error, carried through `@effect/sql`'s
 * `SqlError.cause`, so walk the `cause` chain and return the first string `code`.
 */
function legacyExtractSqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
    const code = Reflect.get(current, "code");
    if (typeof code === "string") return code;
    current = Reflect.get(current, "cause");
  }
  return undefined;
}

/** Structured fields of a Postgres server ErrorResponse (pgconn's `PgError` subset). */
interface LegacyPgServerError {
  readonly severity: string;
  readonly message: string;
  readonly code: string;
  readonly detail?: string;
  readonly position?: number;
}

/**
 * Extracts the server ErrorResponse from a driver error's `cause` chain. The
 * `@effect/sql` `SqlError` wraps its reason on `cause`, and the reason wraps the
 * node-postgres `DatabaseError` the same way; a `DatabaseError` is identified by
 * its string `severity` plus a SQLSTATE-shaped `code` (never a node system error).
 * `detail` and `position` mirror `pgErr.Detail`/`pgErr.Position`
 * (node-postgres carries `position` as a decimal string): `detail` only when
 * non-empty, `position` only when > 0, matching `ExecBatch`'s own gates
 * (`markError` no-ops on 0 anyway).
 */
function legacyExtractPgServerError(error: unknown): LegacyPgServerError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
    const severity = Reflect.get(current, "severity");
    const code = Reflect.get(current, "code");
    if (typeof severity === "string" && typeof code === "string" && legacyIsSqlState(code)) {
      const message = Reflect.get(current, "message");
      const detail = Reflect.get(current, "detail");
      const rawPosition = Reflect.get(current, "position");
      const position = typeof rawPosition === "string" ? Number.parseInt(rawPosition, 10) : NaN;
      return {
        severity,
        message: typeof message === "string" ? message : "",
        code,
        ...(typeof detail === "string" && detail.length > 0 ? { detail } : {}),
        ...(Number.isInteger(position) && position > 0 ? { position } : {}),
      };
    }
    current = Reflect.get(current, "cause");
  }
  return undefined;
}

/**
 * Maps a failed statement to `LegacyDbExecError`. A server ErrorResponse renders
 * pgconn's `PgError.Error()` byte-for-byte — `<Severity>: <Message> (SQLSTATE
 * <Code>)` — which is the head line printed when a
 * migration statement fails, and carries the
 * structured `detail`/`position` fields the migration-apply error context renders.
 * Non-server failures (socket drops, driver errors) keep
 * the driver's own text.
 */
export function legacyToExecError(error: unknown): LegacyDbExecError {
  const server = legacyExtractPgServerError(error);
  if (server !== undefined) {
    return new LegacyDbExecError({
      message: `${server.severity}: ${server.message} (SQLSTATE ${server.code})`,
      code: server.code,
      detail: server.detail,
      position: server.position,
    });
  }
  return new LegacyDbExecError({ message: String(error), code: legacyExtractSqlState(error) });
}

const LEGACY_BATCH_CONNECTION_LOST =
  "connection to the database was lost before the batch could be sent";

/** How far a batch got on the wire: nothing sent, a partial write, or fully written. */
export type LegacyBatchOutcome = "unsent" | "poisoned" | "submitted";

/**
 * Idle time before TCP starts probing a silent peer. Node applies this as the idle delay only,
 * leaving the probe interval and count to the runtime and OS, so a connection whose peer died
 * without a FIN or RST surfaces some minutes after this elapses rather than when it elapses.
 */
const LEGACY_DB_KEEPALIVE_IDLE_MILLIS = 300_000;

/**
 * Maps a failed migration batch to its public error. A batch that never reached the wire
 * is a connectivity failure, not a statement failure, so it reports as one instead of
 * blaming the batch's first statement; anything else keeps `legacyToExecError`'s
 * server-error rendering plus the number of statements that completed.
 */
export function legacyBatchFailureError(
  error: Error,
  batch:
    | {
        readonly completed: number;
        readonly outcome: LegacyBatchOutcome;
        readonly began?: boolean;
        readonly atCommit?: boolean;
      }
    | undefined,
  isLocal: boolean,
): LegacyDbExecError | LegacyDbConnectError {
  if (batch === undefined || batch.outcome === "unsent") {
    return new LegacyDbConnectError({
      message: `${LEGACY_BATCH_CONNECTION_LOST}: ${error.message}`,
      // The checkout failure a tick earlier carries this same hint, so losing the
      // connection mid-batch must not silently drop it.
      ...(isLocal ? { suggestion: LEGACY_SUGGEST_LOCAL_STACK } : {}),
    });
  }
  const mapped = legacyToExecError(error);
  // A lost connection (including a server-initiated termination) is not a BEGIN
  // failure. Gated on SQLSTATE class, never the severity string, which arrives
  // localized (e.g. "FEHLER").
  const server = legacyExtractPgServerError(error);
  const statementFailure = server !== undefined && !legacyIsConnectionEndingSqlState(server.code);
  const beganFailed = batch.outcome === "submitted" && batch.began === false && statementFailure;
  const commitFailed = batch.outcome === "submitted" && batch.atCommit === true && statementFailure;
  return new LegacyDbExecError({
    message: beganFailed
      ? `failed to begin the batch transaction: ${mapped.message}`
      : commitFailed
        ? `failed to commit the batch transaction: ${mapped.message}`
        : mapped.message,
    code: mapped.code,
    detail: mapped.detail,
    position: mapped.position,
    statementIndex: batch.completed,
  });
}

/**
 * Whether a batch's pooled client must be destroyed rather than returned to the pool. A
 * batch that never reached the wire leaves the client looking healthy to pg-pool while its
 * socket is already gone, so the next checkout would write into the same dead connection.
 *
 * A batch that WAS written keeps its client: a statement failure should not cost a redial and
 * a fresh step-down on a single-connection pool. The keep is conditional on `rolledBack` —
 * a failed submitted batch whose rollback failed or timed out is discarded. Recovering
 * from a socket that died after the write is additionally backstopped by pg-pool, which
 * drops a released client whose private `_queryable` flag is false — so that is the behavior
 * to re-check if a pg-pool bump ever breaks the recovery this layer's integration tests
 * assert.
 */
export function legacyShouldDiscardBatchClient(
  batch: { readonly outcome: LegacyBatchOutcome } | undefined,
  exit: Exit.Exit<unknown, unknown>,
  rolledBack: boolean,
): boolean {
  return (
    (batch !== undefined && batch.outcome !== "submitted") ||
    (Exit.isFailure(exit) &&
      (Cause.hasInterrupts(exit.cause) ||
        Cause.hasDies(exit.cause) ||
        (batch?.outcome === "submitted" && !rolledBack)))
  );
}

const legacyEncodeTextArray = (values: ReadonlyArray<string>): string =>
  `{${values
    .map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
    .join(",")}}`;

const legacyEncodeBatchValue = (value: LegacyDbBatchValue): string | null =>
  value === null ? null : typeof value === "string" ? value : legacyEncodeTextArray(value);

export class LegacyPgBatchQuery implements Pg.Submittable {
  readonly statements: ReadonlyArray<{
    readonly sql: string;
    readonly params: ReadonlyArray<string | null>;
  }>;
  callback: (error: Error | undefined) => void;
  completed = 0;
  outcome: LegacyBatchOutcome = "unsent";
  began = false;

  // An error arriving once every caller statement completed can only be COMMIT's.
  get atCommit(): boolean {
    return this.began && this.completed >= this.statements.length;
  }

  constructor(
    statements: ReadonlyArray<LegacyDbBatchStatement>,
    callback: (error: Error | undefined) => void,
  ) {
    this.statements = statements.map(({ sql, params }) => ({
      sql,
      params: (params ?? []).map(legacyEncodeBatchValue),
    }));
    this.callback = callback;
  }

  submit(connection: Pg.Connection): Error | null {
    if (!connection.stream.writable) {
      return new Error("the connection's socket is no longer writable");
    }
    let started = false;
    connection.stream.cork?.();
    try {
      // A bare pipeline is not a transaction block (supabase/cli#6347).
      for (const { sql, params } of [
        { sql: "BEGIN", params: [] },
        ...this.statements,
        { sql: "COMMIT", params: [] },
      ]) {
        started = true;
        connection.parse({ name: "", text: sql, types: [] }, true);
        connection.bind({ portal: "", statement: "", values: [...params] }, true);
        connection.describe({ type: "P", name: "" }, true);
        connection.execute({ portal: "" }, true);
      }
      connection.sync();
    } catch (error) {
      this.outcome = started ? "poisoned" : "unsent";
      return error instanceof Error ? error : new Error(String(error));
    } finally {
      connection.stream.uncork?.();
    }
    // The corked frames only hit the socket at uncork, and a dead peer destroys the
    // stream synchronously during that flush — so only now does writable prove the
    // batch actually left the process.
    if (!connection.stream.writable) {
      return new Error("the connection's socket became unwritable while the batch was flushing");
    }
    this.outcome = "submitted";
    return null;
  }

  handleRowDescription(): void {}

  handleDataRow(): void {}

  handlePortalSuspended(): void {}

  handleCommandComplete(): void {
    this.recordCompletion();
  }

  handleEmptyQuery(): void {
    this.recordCompletion();
  }

  // BEGIN completes first and COMMIT only after every statement; neither counts.
  private recordCompletion(): void {
    if (!this.began) {
      this.began = true;
      return;
    }
    if (this.completed < this.statements.length) {
      this.completed += 1;
    }
  }

  handleCopyInResponse(connection: Pg.Connection): void {
    connection.sendCopyFail("COPY FROM STDIN is not supported in migration batches");
  }

  handleCopyData(): void {}

  handleError(error: Error): void {
    this.callback(error);
  }

  handleReadyForQuery(): void {
    this.callback(undefined);
  }
}

/**
 * Whether a dial host is a libpq unix-socket path. pgconn skips TLS/DNS entirely for
 * a unix `NetworkAddress` regardless of `sslmode` (jackc/pgconn `configTLS`), so a
 * socket DSN connects in plaintext — mirrored here. Matches pgconn v1.14.3
 * `isAbsolutePath`: a forward-slash prefix (POSIX) OR a Windows
 * absolute path — an **uppercase** drive letter `A`-`Z`, then `:`, then `\`
 * (lowercase `c:\…` is NOT a socket in pgconn, so it stays TCP here too).
 */
export function legacyIsUnixSocketHost(host: string): boolean {
  if (host.startsWith("/")) return true;
  return (
    host.length >= 3 && host[0]! >= "A" && host[0]! <= "Z" && host[1] === ":" && host[2] === "\\"
  );
}

/**
 * Build a `postgresql://` connection string carrying the libpq `options` startup
 * parameter. `PgClient.make` only forwards a fixed set of discrete fields to the
 * underlying `pg` pool and has no `options` field, so the legacy Supavisor pooler
 * format (`?options=reference=<ref>`) must travel via the connection string, which
 * `pg-connection-string` parses back into the startup `options` param. `host` is
 * passed explicitly so a DoH-resolved IP can be substituted while TLS still
 * verifies the original hostname (via the `ssl.servername` carried separately).
 * The URL carries no `sslmode`, so the explicit `ssl` config wins.
 *
 * An IPv6 literal host is wrapped in brackets so `new URL()` accepts it, matching
 * `ToPostgresURL` (which formats the host via `net.JoinHostPort`). This
 * covers a direct IPv6 `--db-url` carrying `?options=…` and the DoH path when a
 * Supavisor URL resolves to an AAAA address.
 *
 * A unix-socket host (an absolute path) is percent-encoded as the authority and
 * its port is dropped: `pg-connection-string` only accepts a socket host in a URL
 * via its `/^%2f/i` branch (`postgresql://%2Fvar%2Frun%2Fpostgresql/db`), and a
 * socket dial has no TCP port. Interpolating the raw path makes `new URL()` throw,
 * which would otherwise break a socket DSN carrying startup `options`.
 */
/**
 * Merge the libpq `options` startup param with the parsed `runtimeParams`, encoding
 * each runtime param as a `-c <key>=<value>` flag. Every
 * `pgconn.Config.RuntimeParams` entry is sent as a discrete StartupMessage parameter
 * (`ToPostgresURL`), so the live
 * query/COPY connection applies `search_path`, `statement_timeout`, etc.
 * node-postgres has no discrete startup-param API, but Postgres applies the
 * `-c key=value` flags carried in the `options` startup param to the same session
 * GUCs — behaviorally equivalent, the same pragmatic mapping already used for
 * `options`. Any existing `cfg.options` (e.g. the Supavisor `reference=<ref>` form)
 * is preserved, with the `-c` flags appended. Returns `undefined` when neither is set.
 */
export function legacyMergedConnectionOptions(cfg: LegacyPgConnInput): string | undefined {
  const base = cfg.options !== undefined && cfg.options.length > 0 ? cfg.options : undefined;
  const params = cfg.runtimeParams;
  if (params === undefined || Object.keys(params).length === 0) return base;
  // libpq `options` is space-delimited; a literal backslash or space in a value
  // must be backslash-escaped.
  const escape = (value: string): string => value.replace(/([\\ ])/g, "\\$1");
  const flags = Object.entries(params).map(([key, value]) => `-c ${key}=${escape(value)}`);
  return [...(base === undefined ? [] : [base]), ...flags].join(" ");
}

export function legacyBuildConnectionUrl(
  cfg: LegacyPgConnInput,
  host: string,
  port: number = cfg.port,
): string {
  const isSocket = legacyIsUnixSocketHost(host);
  const hostPart = isSocket ? encodeURIComponent(host) : net.isIP(host) === 6 ? `[${host}]` : host;
  const portPart = isSocket ? "" : `:${port}`;
  const url = new URL(
    `postgresql://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@${hostPart}${portPart}/${encodeURIComponent(cfg.database)}`,
  );
  const options = legacyMergedConnectionOptions(cfg);
  if (options !== undefined && options.length > 0) {
    url.searchParams.set("options", options);
  }
  return url.toString();
}

/**
 * Map the established TLS behavior to the `pg` driver's `ssl` option:
 *
 * - **Local** (`ConnectLocalPostgres` sets `cc.TLSConfig = nil`) → no TLS;
 * return `false` so `pg` stays in plaintext mode even when `PGSSLMODE` is set
 * in the environment. `sslmode` is ignored — the
 * local config overwrites it unconditionally.
 * - **Remote** maps the URL's `sslmode` to the *primary* config pgconn would try
 * (its fallback list), since the `pg` driver carries a single
 * `ssl` option and cannot replay pgconn's TLS↔plaintext fallback:
 * - `disable` and `allow` → plaintext (`ssl: false`). pgconn's `allow` list is
 * `{nil, tlsConfig}`, i.e. a **non-TLS primary** with a TLS fallback, so an
 * `allow` DSN to a plaintext endpoint must connect without TLS.
 * - `verify-ca` / `verify-full` → TLS **with** certificate verification;
 * - `prefer` (and pgconn's default) / `require` / unset → TLS **without**
 * verification (their primary is the TLS config).
 *
 * `servername` (the original hostname) is carried for **every** TLS mode, not
 * just the verifying ones. `sslsni` is enabled by default (pgconn's `config.go`
 * sets `tlsConfig.ServerName = host` for all TLS sslmodes when
 * the host is not a literal IP) and keeps the original hostname in the
 * connection config even when `--dns-resolver https` swaps the dial target for a
 * DoH-resolved IP (via `FallbackLookupIP`). Dropping the SNI on `require`/
 * `prefer` would break endpoints/proxies that route TLS on the server name.
 */
export interface LegacyClientCert {
  readonly cert: string;
  readonly key: string;
  readonly passphrase?: string;
}

export function legacySslOptionFor(
  sslmode: string | undefined,
  isLocal: boolean,
  servername: string | undefined,
  caCert?: string,
  clientCert?: LegacyClientCert,
): boolean | ConnectionOptions | undefined {
  if (isLocal) return false;
  if (sslmode === "disable" || sslmode === "allow") return false;
  const sni = servername !== undefined ? { servername } : {};
  // A configured `sslrootcert` pins the server CA (pgconn loads it into RootCAs);
  // it only affects the verifying modes.
  const ca = caCert !== undefined ? { ca: caCert } : {};
  // pgconn attaches the client `sslcert`/`sslkey` (and optional `sslpassword`) to the
  // single shared `tlsConfig.Certificates` regardless of verification mode,
  // so carry it on every TLS config.
  const clientCertOpts: ConnectionOptions =
    clientCert !== undefined
      ? {
          cert: clientCert.cert,
          key: clientCert.key,
          ...(clientCert.passphrase !== undefined ? { passphrase: clientCert.passphrase } : {}),
        }
      : {};
  if (sslmode === "verify-ca") {
    // pgconn's `verify-ca` verifies the CA chain but **skips hostname**
    // verification (`configTLS` sets a custom `VerifyPeerCertificate` with an
    // empty DNSName and does not set `ServerName` for the check); SNI still
    // carries the host. Node's equivalent is full chain verification with the
    // identity check disabled.
    return {
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined,
      ...ca,
      ...clientCertOpts,
      ...sni,
    };
  }
  if (sslmode === "verify-full") {
    // Full verification, including hostname against the servername.
    return { rejectUnauthorized: true, ...ca, ...clientCertOpts, ...sni };
  }
  // prefer / require / unset → TLS without verification (pgx default).
  return { rejectUnauthorized: false, ...clientCertOpts, ...sni };
}

/**
 * The ordered list of `ssl` configs to try for a connection. pgconn's raw
 * `configTLS` fallback list is **post-processed** by Go's
 * `ConnectByUrl`, which strips
 * every non-TLS fallback whenever the primary config uses TLS ("No fallback from
 * TLS to unsecure connection"). The `pg` driver carries a single `ssl` option and
 * cannot replay pgconn's internal fallback, so `connect` retries across the
 * *post-stripping* list:
 *
 * - `disable` → `[plaintext]` (primary is plaintext; nothing stripped)
 * - `allow` → `[plaintext, TLS]` (`{nil, tlsConfig}` — non-TLS primary, so the
 * TLS fallback survives the strip)
 * - `prefer` / unset (pgconn's default) → `[TLS]`. pgconn's raw list is
 * `{tlsConfig, nil}`, but the primary is TLS, so `ConnectByUrl` drops the
 * plaintext fallback. Go therefore **fails** rather than downgrading a default
 * remote connection to plaintext, and so must this port.
 * - `require` / `verify-ca` / `verify-full` → `[TLS]` (TLS only)
 *
 * `servername` (the original hostname) is per dial host — set when a DoH-resolved
 * IP was substituted so TLS/SNI still targets the hostname. `caCert` is the
 * loaded `sslrootcert` bundle; pgconn treats `require` + a root cert as
 * `verify-ca`, so it is promoted here.
 */
export function legacySslConfigsFor(
  sslmode: string | undefined,
  isLocal: boolean,
  servername: string | undefined,
  caCert?: string,
  host?: string,
  clientCert?: LegacyClientCert,
): Array<boolean | ConnectionOptions | undefined> {
  if (isLocal) return [false];
  // pgconn skips TLS entirely for a unix-socket host (`NetworkAddress == "unix"`)
  // regardless of `sslmode`, so a socket DSN connects in plaintext; never send an
  // SSL negotiation over the socket. Independent of the local/remote flag because a
  // socket path is not the local services hostname (so `isLocal` is `false`).
  if (host !== undefined && legacyIsUnixSocketHost(host)) return [false];
  if (sslmode === "disable") return [false];
  if (sslmode === "allow")
    return [false, legacySslOptionFor("require", false, servername, caCert, clientCert)];
  // pgconn: `require` + a root cert behaves like `verify-ca` (`configTLS`).
  const effectiveMode = sslmode === "require" && caCert !== undefined ? "verify-ca" : sslmode;
  if (
    effectiveMode === "require" ||
    effectiveMode === "verify-ca" ||
    effectiveMode === "verify-full"
  ) {
    return [legacySslOptionFor(effectiveMode, false, servername, caCert, clientCert)];
  }
  // prefer (and the unset default): pgconn's raw list is `{tlsConfig, nil}`, but
  // `ConnectByUrl` strips the plaintext fallback because the primary is TLS, so
  // this is TLS-only — a failed TLS handshake must error, never downgrade.
  return [legacySslOptionFor(sslmode, false, servername, caCert, clientCert)];
}

/**
 * The raw `pg.ClientConfig` for a dial target, choosing the connection-string form
 * whenever a libpq `options`/`runtimeParams` payload must reach the server (see
 * `legacyBuildConnectionUrl`) and discrete fields otherwise (to avoid round-tripping
 * the password through a URL). `copyToCsv` / `queryRaw` reuse it to open a dedicated
 * node-postgres client for the COPY protocol and full result metadata (neither is
 * surfaced by `@effect/sql-pg`), against whichever target the primary connection won.
 */
export function legacyBuildRawPgConfig(
  cfg: LegacyPgConnInput,
  host: string,
  port: number,
  sslOption: boolean | ConnectionOptions | undefined,
  connectTimeoutSeconds: number,
): Pg.ClientConfig {
  const hasOptions = legacyMergedConnectionOptions(cfg) !== undefined;
  return {
    ...(hasOptions
      ? { connectionString: legacyBuildConnectionUrl(cfg, host, port) }
      : { host, port, user: cfg.user, password: cfg.password, database: cfg.database }),
    ...(sslOption === undefined ? {} : { ssl: sslOption }),
    connectionTimeoutMillis: connectTimeoutSeconds * 1000,
    keepAlive: true,
    keepAliveInitialDelayMillis: LEGACY_DB_KEEPALIVE_IDLE_MILLIS,
  };
}

/**
 * The `pg.PoolConfig` for the primary pooled connection. Extends the raw client
 * config with the two pool controls this layer depends on:
 *
 * - `max: 1` — a single physical connection, so a session-scoped `SET SESSION ROLE`
 * (the remote step-down) and any session GUCs persist across `exec`/`query` calls.
 * - `idleTimeoutMillis: 0` — node-postgres documents `0` as disabling auto-reaping of
 * idle connections. `PgClient.make` leaves this unset (→ node-postgres default
 * 10_000ms), which during a long-idle `db pull` (shadow-DB provisioning + diff +
 * interactive confirm prompt) reaps the stepped-down connection after 10s idle and
 * transparently redials a fresh one for the final migration-table write; that fresh
 * connection never ran the step-down, so the DDL executes as the bare `cli_login_*`
 * role and fails with `permission denied` (42501). Disabling the reaper keeps the
 * single stepped-down connection alive for the whole session.
 *
 * `application_name` mirrors `PgClient.make`'s default so the server-side session name
 * is unchanged from the previous `PgClient.make` path.
 *
 * When `stepDownRequired`, the pool also gets the `verify` step-down hook so every
 * new physical connection runs `SET SESSION ROLE postgres` before it is handed out
 * (see `legacyPoolStepDownVerify`).
 */
export function legacyBuildPoolConfig(
  cfg: LegacyPgConnInput,
  host: string,
  port: number,
  sslOption: boolean | ConnectionOptions | undefined,
  connectTimeoutSeconds: number,
  stepDownRequired: boolean,
): Pg.PoolConfig {
  return {
    ...legacyBuildRawPgConfig(cfg, host, port, sslOption, connectTimeoutSeconds),
    idleTimeoutMillis: 0,
    max: 1,
    application_name: "@effect/sql-pg",
    ...(stepDownRequired ? { verify: legacyPoolStepDownVerify } : {}),
  };
}

// Minimal structural views of `pg.Pool` / `pg.PoolClient` used by the pool hooks,
// so the wiring can be unit-tested with a tiny fake at the driver boundary instead
// of a live pool. A real `pg.Pool`/`pg.PoolClient` satisfies these (their `on`
// overloads and `query` signatures are wider).
interface LegacyStepDownClient {
  readonly query: (sql: string) => Promise<unknown>;
}
interface LegacyPoolErrorSource {
  readonly on: (event: "error", listener: (error: Error) => void) => unknown;
}

/**
 * pg-pool `verify` hook that re-runs the remote role step-down on EVERY new
 * physical connection, matching `AfterConnect` —
 * including the silent redial after a dropped connection, which the post-connect
 * one-shot in `connect` can't reach. pg-pool invokes `verify` for a brand-new
 * client BEFORE resolving the pending checkout (`pg-pool/index.js`
 * `_acquireClient`), so the `SET` completes before any caller query runs on that
 * connection. (A `"connect"`-listener `client.query()` would instead overlap
 * pg-pool's own synchronous dispatch of the checked-out query — node-postgres'
 * "Calling client.query() when the client is already executing a query"
 * deprecation, whose internal queueing pg@9 removes.) A failure propagates to
 * the checkout and fails the caller's query, like `AfterConnect` failing
 * the connect.
 */
export function legacyPoolStepDownVerify(
  client: LegacyStepDownClient,
  callback: (err?: Error) => void,
): void {
  client.query(SET_SESSION_ROLE).then(
    () => callback(),
    (error) => callback(error instanceof Error ? error : new Error(String(error))),
  );
}

/**
 * Swallow the pool's async background errors, like `PgClient.make`: an idle
 * client's connection-level failure emits `"error"` on the pool and would crash
 * the process without a listener; the next checkout simply redials (and the
 * redial re-runs the `verify` step-down).
 */
export function legacyInstallPoolErrorSwallow(pool: LegacyPoolErrorSource): void {
  pool.on("error", () => {});
}

// Minimal structural view of the `pg.Pool` surface `legacyAcquireProbedPool`
// drives — a real `pg.Pool` satisfies it (its `on`/`query`/`end` signatures are
// wider), and a tiny fake can stand in at the driver boundary for unit tests.
interface LegacyProbePool extends LegacyPoolErrorSource {
  readonly query: (sql: string) => Promise<unknown>;
  readonly end: () => Promise<void>;
}

/**
 * Acquire a `pg` pool and probe it with `SELECT 1`, guaranteeing the pool is
 * `.end()`ed on EVERY non-success path — a probe rejection, a
 * `connectTimeoutSeconds` timeout, or an interruption.
 *
 * The pool.end() finalizer is registered the MOMENT the pool is constructed, via
 * `Effect.acquireRelease` with a synchronous (never-failing) resource step, BEFORE
 * the probe runs. So even if the probe rejects or the outer timeout fires (a
 * black-holed host), the finalizer is already installed and closes the pool along
 * with its in-flight dial (sockets/timers) when the scope unwinds. Upstream
 * `@effect/sql-pg`'s `PgClient.make` instead probes INSIDE the acquireRelease
 * acquire, so a failed/timed-out probe never installs the finalizer and leaks the
 * pool — we deliberately diverge to fix that leak while keeping the SqlError /
 * ConnectionError shapes identical.
 *
 * The probe pool is generic so tests can inject a lightweight fake at the driver
 * boundary; a real `pg.Pool` is returned unchanged for `PgClient.fromPool`.
 */
export const legacyAcquireProbedPool = <P extends LegacyProbePool>(
  makePool: () => P,
  connectTimeoutSeconds: number,
): Effect.Effect<P, SqlError, Scope.Scope> =>
  Effect.gen(function* () {
    const pool = yield* Effect.acquireRelease(Effect.sync(makePool), (pool) =>
      Effect.promise(() => pool.end()).pipe(Effect.timeoutOption(1000)),
    );
    legacyInstallPoolErrorSwallow(pool);
    yield* Effect.tryPromise({
      try: () => pool.query("SELECT 1"),
      catch: (cause) =>
        new SqlError({
          reason: new ConnectionError({
            cause,
            message: "PgClient: Failed to connect",
            operation: "connect",
          }),
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(connectTimeoutSeconds),
        orElse: () =>
          Effect.fail(
            new SqlError({
              reason: new ConnectionError({
                cause: new Error("Connection timed out"),
                message: "PgClient: Connection timed out",
                operation: "connect",
              }),
            }),
          ),
      }),
    );
    return pool;
  });

/** Map a driver connect failure to the credential-free Go-compatible error. */
const legacyToConnectError = (
  cfg: LegacyPgConnInput,
  isLocal: boolean,
  error: unknown,
): LegacyDbConnectError => {
  const suggestion =
    cfg.suggestionContext === undefined
      ? undefined
      : legacyConnectSuggestion(error, { ...cfg.suggestionContext, isLocal });
  return new LegacyDbConnectError({
    message: `failed to connect to postgres: ${legacyConnectFailureMessage(cfg, error)}`,
    ...(suggestion === undefined ? {} : { suggestion }),
    ...(legacyIsDialFailure(error) ? { retryable: true } : {}),
  });
};

/**
 * Acquire the winning raw pool through the full Go-compatible connection attempt
 * chain. The pool finalizer is owned by the caller's scope; both the legacy session
 * adapter and direct-pool consumers use this one acquisition core so their DNS,
 * TLS, fallback, and role behavior cannot drift apart.
 */
const acquirePgPoolConnection = (
  cfg: LegacyPgConnInput,
  { isLocal, dnsResolver }: LegacyDbConnectOptions,
) =>
  Effect.gen(function* () {
    // pgconn dials the primary host then each HA fallback in order;
    // `cfg.fallbacks` carries the extras parsed from a
    // libpq multi-host connection string. Go installs the Cloudflare DoH resolver
    // for remote connections when `--dns-resolver https` is set:
    // it resolves each host to **all** its IPs
    // (`FallbackLookupIP`) and dials them in order, so we resolve every config host
    // up front and retry each. We dial a resolved IP but keep the original hostname
    // for the TLS `servername` (carried in the `ssl` option) so verification still
    // targets the hostname. Local connections use the host verbatim (native resolver).
    const hostList = [{ host: cfg.host, port: cfg.port }, ...(cfg.fallbacks ?? [])];
    const dialTargets: Array<{ dialHost: string; port: number; servername: string | undefined }> =
      [];
    for (const { host, port } of hostList) {
      // pgconn never resolves a unix-socket host over DNS, so skip DoH for socket
      // paths (DoH-resolving `/var/run/postgresql` is meaningless).
      const resolved =
        dnsResolver === "https" && !isLocal && !legacyIsUnixSocketHost(host)
          ? yield* legacyResolveHostsOverHttps(host)
          : [host];
      for (const dialHost of resolved) {
        dialTargets.push({ dialHost, port, servername: dialHost === host ? undefined : host });
      }
    }
    // Connect timeout parity: `ToPostgresURL` always sets `connect_timeout`,
    // defaulting to 10s; `ConnectLocalPostgres` uses 2s for
    // local. A DSN/`PGCONNECT_TIMEOUT` value (>0) overrides
    // both. Without this a black-holed host would hang to the OS/driver default.
    const connectTimeoutSeconds = cfg.connectTimeoutSeconds ?? (isLocal ? 2 : 10);
    // Whether the remote step-down runs on this connection. The
    // `AfterConnect` hook installs only on the remote path (`ConnectByConfigStream`),
    // not `ConnectLocalPostgres`, so gate on `!isLocal`.
    const stepDownRequired = !isLocal && needsRoleStepDown(cfg.user);
    // Build the primary connection over a self-managed `pg.Pool` rather than
    // `PgClient.make`, so we control two pool
    // behaviors `PgClient.make` does not expose: `idleTimeoutMillis: 0` (never reap
    // the single pooled connection — see `legacyBuildPoolConfig`; the fix for the
    // `db pull` step-down loss) and the per-connection role step-down `verify` hook
    // (see `legacyPoolStepDownVerify`). The `acquire` uses `legacyAcquireProbedPool`:
    // probe with `SELECT 1`, bound the connect by `connectTimeoutSeconds`, and close
    // the pool on scope exit AND on every failure/timeout (the leak `PgClient.make`
    // has). `probe` (below) runs each attempt in a forked scope so a failed fallback
    // attempt's pool closes immediately, before the next host is dialed.
    const makePool = (
      dialHost: string,
      port: number,
      sslOption: boolean | ConnectionOptions | undefined,
    ) =>
      legacyAcquireProbedPool(
        () =>
          new Pg.Pool(
            legacyBuildPoolConfig(
              cfg,
              dialHost,
              port,
              sslOption,
              connectTimeoutSeconds,
              stepDownRequired,
            ),
          ),
        connectTimeoutSeconds,
      );

    // `ConnectByUrl` calls `SetConnectSuggestion(err)` on every connect failure,
    // mapping the driver error to an actionable hint that replaces
    // the generic "--debug" suggestion. The resolver attaches the profile context to
    // `cfg.suggestionContext`; map it here so the suggestion travels on the error.
    // The message mirrors `pgxv5.Connect` wrap of pgconn's `connectError`: the `failed to connect
    // to postgres:` prefix plus the `host=… user=… database=…` identity and the
    // underlying driver cause — not the bare `SqlError` toString, which drops all
    // of that detail.
    // Load the `sslrootcert` CA bundle (pgconn reads it into `RootCAs` at parse
    // time; a missing/unreadable file aborts). Skipped for local connections, which
    // never use TLS. pgconn builds TLS per fallback host, so the CA must be loaded
    // whenever ANY dial target is non-socket — a socket primary with a TCP fallback
    // still needs it (`legacySslConfigsFor` already plaintexts socket targets, so
    // the CA is never applied to a socket dial).
    const rootcertPath = cfg.sslrootcert;
    const anyTcpTarget = dialTargets.some(({ dialHost }) => !legacyIsUnixSocketHost(dialHost));
    const caCert =
      rootcertPath !== undefined && rootcertPath.length > 0 && !isLocal && anyTcpTarget
        ? yield* Effect.try({
            try: () => readFileSync(rootcertPath, "utf8"),
            catch: (error) =>
              new LegacyDbConnectError({
                message: `failed to read sslrootcert ${rootcertPath}: ${error}`,
              }),
          })
        : undefined;

    // Load the client `sslcert`/`sslkey` (pgconn's `configTLS` reads both into
    // `tlsConfig.Certificates` for cert auth; the parser only sets them as a pair).
    // Same non-local/TCP gate as the CA bundle. `sslpassword` decrypts an encrypted
    // key (Node's `tls` `passphrase`). Bound to locals so the narrowing holds in the
    // `Effect.try` closures.
    const certPath = cfg.sslcert;
    const keyPath = cfg.sslkey;
    const clientCert =
      certPath !== undefined && keyPath !== undefined && !isLocal && anyTcpTarget
        ? {
            cert: yield* Effect.try({
              try: () => readFileSync(certPath, "utf8"),
              catch: (error) =>
                new LegacyDbConnectError({
                  message: `failed to read sslcert ${certPath}: ${error}`,
                }),
            }),
            key: yield* Effect.try({
              try: () => readFileSync(keyPath, "utf8"),
              catch: (error) =>
                new LegacyDbConnectError({
                  message: `failed to read sslkey ${keyPath}: ${error}`,
                }),
            }),
            ...(cfg.sslpassword !== undefined ? { passphrase: cfg.sslpassword } : {}),
          }
        : undefined;

    // Build the ordered attempt list, mirroring pgconn's fallback loop
    // (`configTLS` fallback configs, expanded across each resolved address by
    // `expandWithIPs`): each TLS config (`legacySslConfigsFor`) is tried against
    // each dial target (host × resolved IPs). `servername` is per target (the
    // original hostname when we dial a DoH-resolved IP).
    const attempts = dialTargets.flatMap(({ dialHost, port, servername }) =>
      legacySslConfigsFor(cfg.sslmode, isLocal, servername, caCert, dialHost, clientCert).map(
        (ssl) => ({
          pool: makePool(dialHost, port, ssl),
          // pgconn only short-circuits the fallback chain on an auth error when the
          // failed attempt used TLS (gated on `fc.TLSConfig != nil`);
          // a TLS config is any non-plaintext `ssl` value.
          usedTls: ssl !== undefined && ssl !== false,
          rawConfig: legacyBuildRawPgConfig(cfg, dialHost, port, ssl, connectTimeoutSeconds),
        }),
      ),
    );

    // The `pg` driver connects lazily and cannot replay pgconn's fallback, so probe
    // every attempt with `select 1` to force the connection, falling through to the
    // next on failure. pgconn retries fallbacks only for connection-establishment
    // errors; a server-side auth/authorization/catalog/privilege error terminates the
    // chain, so a terminal SQLSTATE re-raises instead of masking
    // the primary's failure behind a later host. The final attempt is probed too (not
    // left lazy): Go always dials eagerly — the main path via `pgx.ConnectConfig` and
    // the temp-role wait via `pgconn.ConnectConfig` — so `connect`
    // must return a live session for callers like `waitForTempRole` that don't run a
    // follow-up query. The winning attempt's `rawConfig` is carried out so `copyToCsv`
    // can reuse the exact dial target the primary connection succeeded against.
    const probe = (attempt: (typeof attempts)[number]) =>
      Effect.gen(function* () {
        // Run each attempt's pool in its OWN scope, forked from the session scope.
        // Forking (not a detached `Scope.make`) means an abandoned winner — e.g. a
        // later step-down failure — is still closed when the session scope unwinds.
        // On a probe FAILURE we close the child immediately, so a failed fallback
        // attempt's pool (and its in-flight dial) is released before the next host is
        // dialed, not left open until session end. On SUCCESS we leave the child open
        // (a child of the session scope), so the winning pool lives for the whole
        // session and closes with it.
        const sessionScope = yield* Scope.Scope;
        const attemptScope = yield* Scope.fork(sessionScope);
        return yield* attempt.pool.pipe(
          Effect.map((pool) => ({ pool, rawConfig: attempt.rawConfig })),
          Scope.provide(attemptScope),
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? Effect.void : Scope.close(attemptScope, exit),
          ),
        );
      });
    const lastIndex = attempts.length - 1;
    const { pool, rawConfig: winningRawConfig } = yield* attempts
      .slice(0, lastIndex)
      .reduceRight(
        (next, attempt) =>
          probe(attempt).pipe(
            Effect.catch((error) =>
              legacyIsTerminalConnectError(error, attempt.usedTls) ? Effect.fail(error) : next,
            ),
          ),
        probe(attempts[lastIndex]!),
      )
      .pipe(Effect.mapError((error) => legacyToConnectError(cfg, isLocal, error)));

    // Step down from the temp/privileged login role before any further SQL — but
    // only for remote connections: Go installs this hook in `ConnectByConfigStream`,
    // not `ConnectLocalPostgres`, so a local `--db-url` using `supabase_admin`/
    // `cli_login_*` must not run it. The pool's `verify` hook already ran this on
    // the physical connection (and runs it on any silent redial); this explicit
    // one-shot preserves the fail-fast `LegacyDbConnectError: failed to set session
    // role: ...` path. `max: 1` + `idleTimeoutMillis: 0` keep the stepped-down connection
    // alive so the session-scoped role persists for every later `exec`/`query`.
    if (stepDownRequired) {
      yield* Effect.tryPromise({
        try: () => pool.query(SET_SESSION_ROLE),
        catch: (error) =>
          new LegacyDbConnectError({ message: `failed to set session role: ${error}` }),
      });
    }

    return { pool, winningRawConfig, stepDownRequired };
  });

/**
 * Acquire a live `pg.Pool` using the same scoped lifecycle and connection parity
 * as `LegacyDbConnection.connect`. The caller owns the surrounding scope; closing
 * it ends the winning pool, while every losing fallback attempt is closed before
 * the next target is tried.
 */
export const legacyAcquirePgPool = (
  cfg: LegacyPgConnInput,
  options: LegacyDbConnectOptions,
): Effect.Effect<Pg.Pool, LegacyDbConnectError, Scope.Scope> =>
  acquirePgPoolConnection(cfg, options).pipe(Effect.map(({ pool }) => pool));

/**
 * Default `LegacyDbConnection` layer, backed by `@effect/sql-pg` (pure-JS `pg`
 * driver, no native addon — bundles under `bun build --compile`). Each
 * `connect` builds a scoped single-client connection that closes on scope exit.
 */
const connect = (
  cfg: LegacyPgConnInput,
  options: LegacyDbConnectOptions,
): Effect.Effect<LegacyDbSession, LegacyDbConnectError, Scope.Scope> =>
  Effect.gen(function* () {
    const { pool, winningRawConfig, stepDownRequired } = yield* acquirePgPoolConnection(
      cfg,
      options,
    );
    const client = yield* PgClient.fromPool({ acquire: Effect.succeed(pool) }).pipe(
      Effect.provide(Reactivity.layer),
      Effect.mapError((error) => legacyToConnectError(cfg, options.isLocal, error)),
    );

    // `inspect report` runs ~14 `COPY (...) TO STDOUT` statements. node-postgres'
    // COPY protocol needs the raw client (which `@effect/sql-pg` does not surface),
    // so the session opens ONE dedicated raw connection against the winning dial
    // target and reuses it for every copy — matching Go, which runs all copies on a
    // single `pgconn`. It is created lazily on first copy (so
    // `test db` / `inspect db`, which never copy, never open it) and closed by a
    // scope finalizer when the session's scope closes. The step-down runs once, here,
    // so every COPY executes with the same privileges as the primary session.
    let rawClient: Pg.Client | undefined;
    yield* Effect.addFinalizer(() =>
      rawClient === undefined
        ? Effect.void
        : Effect.promise(() => rawClient!.end().catch(() => {})),
    );
    // A dedicated raw node-postgres client, reused by `copyToCsv` (COPY protocol)
    // and `queryRaw` (full result metadata) — neither is surfaced by
    // `@effect/sql-pg`. Opened lazily against the winning dial target so TLS /
    // fallback / DoH parity is preserved, with the same role step-down as the
    // primary session. Establishing this connection (and its step-down) is a
    // connection-setup concern, so it fails with `LegacyDbConnectError` using the
    // same message shape as the primary `connect` — not a copy/exec error. Only
    // the COPY stream itself (in `copyToCsv`) raises `LegacyDbCopyError`; this
    // keeps `queryRaw` failures from surfacing a misleading "failed to copy
    // output" message when the shared client cannot be established.
    const acquireRawClient = Effect.gen(function* () {
      if (rawClient !== undefined) return rawClient;
      const fresh = new Pg.Client(winningRawConfig);
      // node-postgres emits `error` on a cached client whose socket dies while idle; with
      // no listener that terminates the process, so absorb it and drop the dead client so
      // the next acquisition redials instead of reusing it.
      fresh.on("error", () => {
        if (rawClient === fresh) rawClient = undefined;
      });
      yield* Effect.tryPromise({
        try: () => fresh.connect(),
        catch: (error) => legacyToConnectError(cfg, options.isLocal, error),
      });
      if (stepDownRequired) {
        yield* Effect.tryPromise({
          try: () => fresh.query(SET_SESSION_ROLE),
          catch: (error) =>
            new LegacyDbConnectError({ message: `failed to set session role: ${error}` }),
        });
      }
      rawClient = fresh;
      return fresh;
    });

    // Checking a connection out of the pool for a batch is a connection-setup
    // concern, so it fails with `LegacyDbConnectError` — the same classification
    // `acquireRawClient` uses above, and for the same reason: the pool may have to
    // redial (its single connection is discarded after an interrupted, poisoned, or
    // unsent batch), and a refused/auth/DNS failure there is not a statement failure.
    // Mapping it to `LegacyDbExecError` would lose the connect suggestion and make the
    // migration-apply formatter blame the batch's first statement for a connectivity
    // problem — which is also why a batch that never reached the wire reports the same
    // way (below). Only a batch that was actually written raises `LegacyDbExecError`.
    const acquireBatchClient = Effect.callback<Pg.PoolClient, LegacyDbConnectError>((resume) => {
      let done = false;
      try {
        pool.connect((error, activeClient) => {
          if (done) {
            activeClient?.release();
            return;
          }
          done = true;
          if (error !== undefined) {
            resume(Effect.fail(legacyToConnectError(cfg, options.isLocal, error)));
          } else if (activeClient === undefined) {
            resume(
              Effect.fail(
                new LegacyDbConnectError({ message: "failed to acquire batch connection" }),
              ),
            );
          } else {
            resume(Effect.succeed(activeClient));
          }
        });
      } catch (error) {
        done = true;
        resume(Effect.fail(legacyToConnectError(cfg, options.isLocal, error)));
      }
      return Effect.sync(() => {
        done = true;
      });
    });

    const execBatch = (statements: ReadonlyArray<LegacyDbBatchStatement>) => {
      if (statements.length === 0) return Effect.void;
      // Suspended so each evaluation owns fresh batch/rollback state.
      return Effect.suspend(() => {
        let batchQuery: LegacyPgBatchQuery | undefined;
        let rolledBack = false;
        // Spans the whole checkout: an unlistened 'error' kills the process (see
        // acquireRawClient) and pg-pool detaches its own handler while checked out.
        const onConnectionError = () => {};
        return Effect.acquireUseRelease(
          Effect.interruptible(acquireBatchClient).pipe(
            Effect.tap((activeClient) =>
              Effect.sync(() => activeClient.on("error", onConnectionError)),
            ),
          ),
          (activeClient) =>
            Effect.callback<void, LegacyDbExecError | LegacyDbConnectError>((resume) => {
              let done = false;
              const finish = (error: Error | undefined) => {
                if (done) return;
                done = true;
                if (error === undefined) {
                  resume(Effect.void);
                  return;
                }
                resume(Effect.fail(legacyBatchFailureError(error, batchQuery, options.isLocal)));
              };
              batchQuery = new LegacyPgBatchQuery(statements, finish);
              try {
                activeClient.query(batchQuery);
              } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
              }
              return Effect.sync(() => {
                done = true;
              });
            }).pipe(
              // Roll a written batch's aborted transaction back while still
              // interruptible; a rollback that fails or times out leaves the client
              // to the discard below instead of returning it aborted (25P02).
              Effect.tapError(() =>
                Effect.suspend(() => {
                  if (batchQuery?.outcome !== "submitted") return Effect.void;
                  return Effect.promise(() => {
                    try {
                      return activeClient.query("ROLLBACK").then(
                        () => true,
                        () => false,
                      );
                    } catch {
                      return Promise.resolve(false);
                    }
                  }).pipe(
                    Effect.timeoutOption(1000),
                    Effect.map((result) => {
                      rolledBack = Option.getOrElse(result, () => false);
                    }),
                  );
                }),
              ),
            ),
          (activeClient, exit) =>
            Effect.sync(() => {
              const discard = legacyShouldDiscardBatchClient(batchQuery, exit, rolledBack);
              try {
                activeClient.release(discard ? new Error("batch connection discarded") : undefined);
              } finally {
                activeClient.removeListener("error", onConnectionError);
              }
            }),
        );
      });
    };

    const session: LegacyDbSession = {
      ...(stepDownRequired ? { restoreRoleSql: SET_SESSION_ROLE } : {}),
      exec: (sql) => client.unsafe(sql).pipe(Effect.asVoid, Effect.mapError(legacyToExecError)),
      execBatch,
      query: (sql, params) =>
        client
          .unsafe<Record<string, unknown>>(sql, params)
          .pipe(Effect.mapError(legacyToExecError)),
      extensionExists: (name) =>
        client`select 1 from pg_extension where extname = ${name}`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(legacyToExecError),
        ),
      queryRaw: (sql) =>
        Effect.gen(function* () {
          // `acquireRawClient` fails with `LegacyDbConnectError`; surface it
          // verbatim (the public `queryRaw` type allows it) rather than masking a
          // connection failure as "failed to execute query".
          const activeClient = yield* acquireRawClient;
          // Capture the raw command tag from the protocol message: node-postgres'
          // parsed `Result.command` keeps only the first tag word (e.g. "CREATE"
          // for "CREATE TABLE"), but Go prints the full `pgconn` tag.
          let commandTag = "";
          const onComplete = (msg: { readonly text?: string }) => {
            if (typeof msg.text === "string") commandTag = msg.text;
          };
          activeClient.connection.on("commandComplete", onComplete);
          const result = yield* Effect.tryPromise({
            // `rowMode: "array"` returns rows positionally so duplicate column
            // names survive (Go reads pgx values by index). `types` keeps date/
            // timestamp/timestamptz cells as raw text to preserve microseconds.
            // `queryMode: "extended"` forces the Parse/Bind/Execute protocol so a
            // multi-statement string is rejected — Go's pgx v4 defaults to the
            // extended protocol (`cannot insert multiple commands into a prepared
            // statement`), whereas node-postgres' default simple protocol would
            // execute every statement (an empty `values` array stays simple, since
            // pg gates preparation on `values.length > 0`).
            try: () =>
              activeClient.query<Array<unknown>>({
                text: sql,
                queryMode: "extended",
                rowMode: "array",
                types: legacyQueryRawTypes,
              }),
            catch: (error) =>
              new LegacyDbExecError({ message: `failed to execute query: ${error}` }),
          }).pipe(
            Effect.ensuring(
              Effect.sync(() =>
                activeClient.connection.removeListener("commandComplete", onComplete),
              ),
            ),
          );
          return {
            fields: result.fields.map((field) => field.name),
            // Surface the column type OIDs so the table/CSV formatter can render
            // float4/float8 with Go's %g while integer columns stay plain.
            fieldTypeIds: result.fields.map((field) => field.dataTypeID),
            rows: result.rows,
            commandTag,
          };
        }),
      copyToCsv: (sql) =>
        Effect.gen(function* () {
          const activeClient = yield* acquireRawClient;
          return yield* Effect.callback<Uint8Array, LegacyDbCopyError>((resume) => {
            const stream = activeClient.query(pgCopyTo(sql));
            const chunks: Array<Buffer> = [];
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("error", (error: Error) =>
              resume(
                Effect.fail(new LegacyDbCopyError({ message: `failed to copy output: ${error}` })),
              ),
            );
            stream.on("end", () => resume(Effect.succeed(new Uint8Array(Buffer.concat(chunks)))));
          });
        }),
    };
    return session;
  });

export const legacyDbConnectionSqlPgLayer = Layer.succeed(LegacyDbConnection, { connect });
