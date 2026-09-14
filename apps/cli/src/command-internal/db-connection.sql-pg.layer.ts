import { readFileSync } from "node:fs";
import * as net from "node:net";
import type { ConnectionOptions } from "node:tls";
import { PgClient } from "@effect/sql-pg";
import { Cause, Duration, Effect, Exit, Layer, Scope } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { ConnectionError, SqlError } from "effect/unstable/sql/SqlError";
// `pg` is `@effect/sql-pg`'s transitive driver; used directly here for COPY and
// extended-protocol batches, which `@effect/sql-pg` does not expose. Keep the direct `pg`
// version in package.json aligned with the one `@effect/sql-pg` resolves.
import * as Pg from "pg";
import { to as pgCopyTo } from "pg-copy-streams";
import {
  SUGGEST_LOCAL_STACK,
  connectFailureMessage,
  connectSuggestion,
  isDialFailure,
  isSqlState,
} from "./connect-errors.ts";
import { DbConnectError, DbCopyError, DbExecError } from "./db-connection.errors.ts";
import {
  type DbBatchStatement,
  type DbBatchValue,
  type DbConnectOptions,
  DbConnection,
  type DbSession,
  type PgConnInput,
} from "./db-connection.service.ts";
import { resolveHostsOverHttps } from "./db-dns.ts";

// `@types/pg` doesn't declare `queryMode` on `QueryConfig`, `verify` on `PoolConfig` (run for
// every new physical connection before checkout), or `PoolClient.connection`/
// `Connection.sendCopyFail`, all of which node-postgres supports at runtime. Augment them here.
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

// After connecting to a remote database as a platform-provisioned login role (`cli_login_*`) or
// a privileged role (`supabase_admin`), run `SET SESSION ROLE postgres` so subsequent statements
// (e.g. `CREATE EXTENSION`) execute as `postgres` rather than the temp role.
const SUPERUSER_ROLE = "supabase_admin";
const CLI_LOGIN_PREFIX = "cli_login_";
const SET_SESSION_ROLE = "SET SESSION ROLE postgres";

// Postgres date/timestamp/timestamptz type OIDs. node-postgres' default parsers decode these
// into a JS `Date`, which is millisecond-resolution and applies the local timezone, losing
// precision and risking a date shift. For `db query` we keep the raw Postgres text instead so
// the formatter renders timestamps faithfully, with microseconds intact.
const PG_DATE_OID = 1082;
const PG_TIMESTAMP_OID = 1114;
const PG_TIMESTAMPTZ_OID = 1184;
const keepRawText = (value: string): string => value;
/**
 * Per-query node-postgres type config: return the raw text for date/timestamp/
 * timestamptz, delegating every other OID to pg's default (text-mode) parser. Scoped
 * to `queryRaw` (only `db query` uses it), so other code paths keep native `Date`s.
 */
const queryRawTypes = {
  getTypeParser: (oid: number, format?: "text" | "binary") =>
    oid === PG_DATE_OID || oid === PG_TIMESTAMP_OID || oid === PG_TIMESTAMPTZ_OID
      ? keepRawText
      : format === undefined
        ? Pg.types.getTypeParser(oid)
        : Pg.types.getTypeParser(oid, format),
};

/**
 * Whether the connecting user requires the `SET SESSION ROLE postgres` step-down. Strips any
 * Supavisor `.{ref}` tenant suffix first. Only applies on the remote path; the caller must also
 * gate on `!isLocal`, since a local `--db-url` can set any user without triggering step-down.
 */
function needsRoleStepDown(user: string): boolean {
  const base = user.split(".")[0] ?? user;
  return base.toLowerCase() === SUPERUSER_ROLE || base.startsWith(CLI_LOGIN_PREFIX);
}

// These SQLSTATEs terminate the multi-host fallback chain instead of trying the next host,
// since they indicate the server rejected the attempt rather than being unreachable; `28000`
// only terminates when the failed attempt used TLS.
const TERMINAL_SQLSTATES = new Set(["28P01", "3D000", "42501"]);
const TLS_GATED_SQLSTATE = "28000";

/**
 * Whether a failed connection attempt should terminate the multi-host fallback chain instead of
 * falling through to the next host: fallbacks are retried only for connection-establishment
 * errors, while server-side auth errors return immediately. The `pg` driver attaches the
 * Postgres SQLSTATE as a `code` property on the server error, carried through `@effect/sql`'s
 * `SqlError.cause`, so this walks the `cause` chain looking for one.
 */
export function isTerminalConnectError(error: unknown, usedTls: boolean): boolean {
  const code = extractSqlState(error);
  if (code === undefined) return false;
  if (TERMINAL_SQLSTATES.has(code)) return true;
  return code === TLS_GATED_SQLSTATE && usedTls;
}

/**
 * Extracts the Postgres SQLSTATE from a driver error. The `pg` driver attaches the
 * code as a `code` property on the server error, carried through `@effect/sql`'s
 * `SqlError.cause`, so walk the `cause` chain and return the first string `code`.
 */
function extractSqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
    const code = Reflect.get(current, "code");
    if (typeof code === "string") return code;
    current = Reflect.get(current, "cause");
  }
  return undefined;
}

/** Structured fields of a Postgres server ErrorResponse. */
interface PgServerError {
  readonly severity: string;
  readonly message: string;
  readonly code: string;
  readonly detail?: string;
  readonly position?: number;
}

/**
 * Extracts the server ErrorResponse from a driver error's `cause` chain. `@effect/sql`'s
 * `SqlError` wraps its reason on `cause`, which wraps the node-postgres `DatabaseError` the same
 * way; a `DatabaseError` is identified by its string `severity` plus a SQLSTATE-shaped `code`
 * (never a node system error). `detail` is included only when non-empty, and `position` (carried
 * by node-postgres as a decimal string) only when > 0.
 */
function extractPgServerError(error: unknown): PgServerError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
    const severity = Reflect.get(current, "severity");
    const code = Reflect.get(current, "code");
    if (typeof severity === "string" && typeof code === "string" && isSqlState(code)) {
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
 * Maps a failed statement to `DbExecError`. A server ErrorResponse renders as
 * `<Severity>: <Message> (SQLSTATE <Code>)`, the head line printed when a migration statement
 * fails, and carries the structured `detail`/`position` fields the migration-apply error context
 * renders. Non-server failures (socket drops, driver errors) keep the driver's own text.
 */
export function toExecError(error: unknown): DbExecError {
  const server = extractPgServerError(error);
  if (server !== undefined) {
    return new DbExecError({
      message: `${server.severity}: ${server.message} (SQLSTATE ${server.code})`,
      code: server.code,
      detail: server.detail,
      position: server.position,
    });
  }
  return new DbExecError({ message: String(error), code: extractSqlState(error) });
}

const BATCH_CONNECTION_LOST = "connection to the database was lost before the batch could be sent";

/** How far a batch got on the wire: nothing sent, a partial write, or fully written. */
export type BatchOutcome = "unsent" | "poisoned" | "submitted";

/**
 * Idle time before TCP starts probing a silent peer. Node applies this as the idle delay only,
 * leaving the probe interval and count to the runtime and OS, so a connection whose peer died
 * without a FIN or RST surfaces some minutes after this elapses rather than when it elapses.
 */
const DB_KEEPALIVE_IDLE_MILLIS = 300_000;

/**
 * Maps a failed migration batch to its public error. A batch that never reached the wire
 * is a connectivity failure, not a statement failure, so it reports as one instead of
 * blaming the batch's first statement; anything else keeps `toExecError`'s
 * server-error rendering plus the number of statements that completed.
 */
export function batchFailureError(
  error: Error,
  batch: { readonly completed: number; readonly outcome: BatchOutcome } | undefined,
  isLocal: boolean,
): DbExecError | DbConnectError {
  if (batch === undefined || batch.outcome === "unsent") {
    return new DbConnectError({
      message: `${BATCH_CONNECTION_LOST}: ${error.message}`,
      // The checkout failure a tick earlier carries this same hint, so losing the
      // connection mid-batch must not silently drop it.
      ...(isLocal ? { suggestion: SUGGEST_LOCAL_STACK } : {}),
    });
  }
  const mapped = toExecError(error);
  return new DbExecError({
    message: mapped.message,
    code: mapped.code,
    detail: mapped.detail,
    position: mapped.position,
    statementIndex: batch.completed,
  });
}

/**
 * Whether a batch's pooled client must be destroyed rather than returned to the pool. A batch
 * that never reached the wire leaves the client looking healthy to pg-pool while its socket is
 * already gone, so the next checkout would write into the same dead connection.
 *
 * A batch that was written keeps its client: a statement failure should not cost a redial and a
 * fresh step-down on a single-connection pool. Recovery from a socket that died after the write
 * is left to pg-pool's own dead-client detection.
 */
export function shouldDiscardBatchClient(
  batch: { readonly outcome: BatchOutcome } | undefined,
  exit: Exit.Exit<unknown, unknown>,
): boolean {
  return (
    (batch !== undefined && batch.outcome !== "submitted") ||
    (Exit.isFailure(exit) && (Cause.hasInterrupts(exit.cause) || Cause.hasDies(exit.cause)))
  );
}

const encodeTextArray = (values: ReadonlyArray<string>): string =>
  `{${values
    .map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
    .join(",")}}`;

const encodeBatchValue = (value: DbBatchValue): string | null =>
  value === null ? null : typeof value === "string" ? value : encodeTextArray(value);

export class PgBatchQuery implements Pg.Submittable {
  readonly statements: ReadonlyArray<{
    readonly sql: string;
    readonly params: ReadonlyArray<string | null>;
  }>;
  callback: (error: Error | undefined) => void;
  completed = 0;
  outcome: BatchOutcome = "unsent";

  constructor(
    statements: ReadonlyArray<DbBatchStatement>,
    callback: (error: Error | undefined) => void,
  ) {
    this.statements = statements.map(({ sql, params }) => ({
      sql,
      params: (params ?? []).map(encodeBatchValue),
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
      for (const { sql, params } of this.statements) {
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
    this.completed += 1;
  }

  handleEmptyQuery(): void {
    this.completed += 1;
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
 * Whether a dial host is a libpq unix-socket path: a forward-slash prefix (POSIX), or a Windows
 * absolute path — an uppercase drive letter `A`-`Z`, then `:`, then `\` (lowercase `c:\…` is not
 * treated as a socket, so it stays TCP). A socket DSN always connects in plaintext, skipping
 * TLS/DNS entirely.
 */
export function isUnixSocketHost(host: string): boolean {
  if (host.startsWith("/")) return true;
  return (
    host.length >= 3 && host[0]! >= "A" && host[0]! <= "Z" && host[1] === ":" && host[2] === "\\"
  );
}

/**
 * Builds a `postgresql://` connection string carrying the libpq `options` startup parameter,
 * since `PgClient.make` has no `options` field of its own. `host` is passed explicitly so a
 * DoH-resolved IP can be substituted while TLS still verifies the original hostname via a
 * separately carried `ssl.servername`. An IPv6 literal host is bracketed for `new URL()`, and a
 * unix-socket host is percent-encoded as the authority with its port dropped, since a raw path
 * makes `new URL()` throw.
 */
/**
 * Merges the libpq `options` startup param with the parsed `runtimeParams`, encoding each
 * runtime param as a `-c <key>=<value>` flag: node-postgres has no discrete startup-param API,
 * but Postgres applies `-c key=value` flags in `options` to the same session GUCs. Any existing
 * `cfg.options` (e.g. the Supavisor `reference=<ref>` form) is preserved, with the `-c` flags
 * appended. Returns `undefined` when neither is set.
 */
export function mergedConnectionOptions(cfg: PgConnInput): string | undefined {
  const base = cfg.options !== undefined && cfg.options.length > 0 ? cfg.options : undefined;
  const params = cfg.runtimeParams;
  if (params === undefined || Object.keys(params).length === 0) return base;
  // libpq `options` is space-delimited; a literal backslash or space in a value
  // must be backslash-escaped.
  const escape = (value: string): string => value.replace(/([\\ ])/g, "\\$1");
  const flags = Object.entries(params).map(([key, value]) => `-c ${key}=${escape(value)}`);
  return [...(base === undefined ? [] : [base]), ...flags].join(" ");
}

export function buildConnectionUrl(
  cfg: PgConnInput,
  host: string,
  port: number = cfg.port,
): string {
  const isSocket = isUnixSocketHost(host);
  const hostPart = isSocket ? encodeURIComponent(host) : net.isIP(host) === 6 ? `[${host}]` : host;
  const portPart = isSocket ? "" : `:${port}`;
  const url = new URL(
    `postgresql://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@${hostPart}${portPart}/${encodeURIComponent(cfg.database)}`,
  );
  const options = mergedConnectionOptions(cfg);
  if (options !== undefined && options.length > 0) {
    url.searchParams.set("options", options);
  }
  return url.toString();
}

/**
 * Maps `sslmode` to the `pg` driver's single `ssl` option, since it cannot replay libpq's
 * TLS/plaintext fallback list the way multi-attempt dialing does. `servername` (the original
 * hostname) is carried for every TLS mode, not just the verifying ones, so SNI still targets the
 * hostname even when `--dns-resolver https` substitutes a DoH-resolved dial IP.
 */
export interface ClientCert {
  readonly cert: string;
  readonly key: string;
  readonly passphrase?: string;
}

export function sslOptionFor(
  sslmode: string | undefined,
  isLocal: boolean,
  servername: string | undefined,
  caCert?: string,
  clientCert?: ClientCert,
): boolean | ConnectionOptions | undefined {
  if (isLocal) return false;
  if (sslmode === "disable" || sslmode === "allow") return false;
  const sni = servername !== undefined ? { servername } : {};
  // A configured `sslrootcert` pins the server CA; it only affects the verifying modes.
  const ca = caCert !== undefined ? { ca: caCert } : {};
  // Client cert/key (and optional passphrase) apply regardless of verification mode, so carry
  // them on every TLS config.
  const clientCertOpts: ConnectionOptions =
    clientCert !== undefined
      ? {
          cert: clientCert.cert,
          key: clientCert.key,
          ...(clientCert.passphrase !== undefined ? { passphrase: clientCert.passphrase } : {}),
        }
      : {};
  if (sslmode === "verify-ca") {
    // `verify-ca` verifies the CA chain but skips hostname verification; SNI still carries the
    // host. Node's equivalent is full chain verification with the identity check disabled.
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
  // prefer / require / unset → TLS without verification (the default).
  return { rejectUnauthorized: false, ...clientCertOpts, ...sni };
}

/**
 * The ordered list of `ssl` configs to try for a connection: `disable` → plaintext only;
 * `allow` → plaintext then TLS; `prefer`/unset/`require`/`verify-ca`/`verify-full` → TLS only,
 * so a failed handshake on the default `prefer` mode fails loudly rather than silently
 * downgrading to plaintext. `servername` targets the original hostname per dial host when a
 * DoH-resolved IP was substituted; `caCert` promotes `require` to `verify-ca` when set.
 */
export function sslConfigsFor(
  sslmode: string | undefined,
  isLocal: boolean,
  servername: string | undefined,
  caCert?: string,
  host?: string,
  clientCert?: ClientCert,
): Array<boolean | ConnectionOptions | undefined> {
  if (isLocal) return [false];
  // A unix-socket host always connects in plaintext, regardless of `sslmode`; never send an SSL
  // negotiation over the socket. Independent of `isLocal`, since a socket path isn't the local
  // services hostname.
  if (host !== undefined && isUnixSocketHost(host)) return [false];
  if (sslmode === "disable") return [false];
  if (sslmode === "allow")
    return [false, sslOptionFor("require", false, servername, caCert, clientCert)];
  // `require` plus a root cert behaves like `verify-ca`.
  const effectiveMode = sslmode === "require" && caCert !== undefined ? "verify-ca" : sslmode;
  if (
    effectiveMode === "require" ||
    effectiveMode === "verify-ca" ||
    effectiveMode === "verify-full"
  ) {
    return [sslOptionFor(effectiveMode, false, servername, caCert, clientCert)];
  }
  // prefer (and the unset default) is TLS-only: a failed handshake must error, never downgrade
  // to plaintext.
  return [sslOptionFor(sslmode, false, servername, caCert, clientCert)];
}

/**
 * The raw `pg.ClientConfig` for a dial target: the connection-string form when a libpq
 * `options`/`runtimeParams` payload must reach the server (see {@link buildConnectionUrl}),
 * discrete fields otherwise, to avoid round-tripping the password through a URL. `copyToCsv` /
 * `queryRaw` reuse it to open a dedicated node-postgres client against whichever target the
 * primary connection won.
 */
export function buildRawPgConfig(
  cfg: PgConnInput,
  host: string,
  port: number,
  sslOption: boolean | ConnectionOptions | undefined,
  connectTimeoutSeconds: number,
): Pg.ClientConfig {
  const hasOptions = mergedConnectionOptions(cfg) !== undefined;
  return {
    ...(hasOptions
      ? { connectionString: buildConnectionUrl(cfg, host, port) }
      : { host, port, user: cfg.user, password: cfg.password, database: cfg.database }),
    ...(sslOption === undefined ? {} : { ssl: sslOption }),
    connectionTimeoutMillis: connectTimeoutSeconds * 1000,
    keepAlive: true,
    keepAliveInitialDelayMillis: DB_KEEPALIVE_IDLE_MILLIS,
  };
}

/**
 * The `pg.PoolConfig` for the primary pooled connection: `max: 1` so a session-scoped
 * `SET SESSION ROLE` and any session GUCs persist across `exec`/`query` calls, and
 * `idleTimeoutMillis: 0` because the default reaper can silently redial mid-session (e.g. during
 * a long-idle `db pull`) onto a fresh connection that never ran the step-down, failing with
 * `permission denied`. When `stepDownRequired`, the pool also gets {@link poolStepDownVerify} so
 * every new physical connection runs the step-down before being handed out.
 */
export function buildPoolConfig(
  cfg: PgConnInput,
  host: string,
  port: number,
  sslOption: boolean | ConnectionOptions | undefined,
  connectTimeoutSeconds: number,
  stepDownRequired: boolean,
): Pg.PoolConfig {
  return {
    ...buildRawPgConfig(cfg, host, port, sslOption, connectTimeoutSeconds),
    idleTimeoutMillis: 0,
    max: 1,
    application_name: "@effect/sql-pg",
    ...(stepDownRequired ? { verify: poolStepDownVerify } : {}),
  };
}

// Minimal structural view of `pg.Pool`/`pg.PoolClient` used by the pool hooks, satisfied by
// both the real driver and lightweight test fakes.
interface StepDownClient {
  readonly query: (sql: string) => Promise<unknown>;
}
interface PoolErrorSource {
  readonly on: (event: "error", listener: (error: Error) => void) => unknown;
}

/**
 * pg-pool `verify` hook that re-runs the remote role step-down on every new physical connection,
 * including a silent redial after a dropped connection that the post-connect one-shot in
 * `connect` can't reach. pg-pool invokes `verify` before resolving the pending checkout, so the
 * `SET` completes before any caller query runs; a `"connect"`-listener `client.query()` would
 * instead race pg-pool's own dispatch of the checked-out query. A failure here fails the
 * checkout, propagating to the caller's query.
 */
export function poolStepDownVerify(client: StepDownClient, callback: (err?: Error) => void): void {
  client.query(SET_SESSION_ROLE).then(
    () => callback(),
    (error) => callback(error instanceof Error ? error : new Error(String(error))),
  );
}

/**
 * Swallows the pool's async background errors: an idle client's connection-level failure emits
 * `"error"` on the pool and would crash the process without a listener. The next checkout
 * simply redials, re-running the `verify` step-down.
 */
export function installPoolErrorSwallow(pool: PoolErrorSource): void {
  pool.on("error", () => {});
}

// Minimal structural view of the `pg.Pool` surface `acquireProbedPool` drives; a real
// `pg.Pool` or a lightweight test fake both satisfy it.
interface ProbePool extends PoolErrorSource {
  readonly query: (sql: string) => Promise<unknown>;
  readonly end: () => Promise<void>;
}

/**
 * Acquires a `pg` pool and probes it with `SELECT 1`, guaranteeing the pool is closed on every
 * non-success path (probe rejection, connect timeout, or interruption). The `pool.end()`
 * finalizer registers the moment the pool is constructed, before the probe runs, unlike
 * upstream `@effect/sql-pg`'s `PgClient.make`, which probes inside its acquire step and leaks
 * the pool on a failed/timed-out probe. The probe pool is generic so tests can inject a
 * lightweight fake at the driver boundary.
 */
export const acquireProbedPool = <P extends ProbePool>(
  makePool: () => P,
  connectTimeoutSeconds: number,
): Effect.Effect<P, SqlError, Scope.Scope> =>
  Effect.gen(function* () {
    const pool = yield* Effect.acquireRelease(Effect.sync(makePool), (pool) =>
      Effect.promise(() => pool.end()).pipe(Effect.timeoutOption(1000)),
    );
    installPoolErrorSwallow(pool);
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

/** Maps a driver connect failure to a credential-free `DbConnectError`. */
const toConnectError = (cfg: PgConnInput, isLocal: boolean, error: unknown): DbConnectError => {
  const suggestion =
    cfg.suggestionContext === undefined
      ? undefined
      : connectSuggestion(error, { ...cfg.suggestionContext, isLocal });
  return new DbConnectError({
    message: `failed to connect to postgres: ${connectFailureMessage(cfg, error)}`,
    ...(suggestion === undefined ? {} : { suggestion }),
    ...(isDialFailure(error) ? { retryable: true } : {}),
  });
};

/**
 * Acquires the winning raw pool through the full connection attempt chain (DNS resolution, TLS
 * negotiation, host fallback, role step-down). The pool finalizer is owned by the caller's
 * scope; both the session adapter and direct-pool consumers share this one acquisition core so
 * that behavior cannot drift apart between them.
 */
const acquirePgPoolConnection = (cfg: PgConnInput, { isLocal, dnsResolver }: DbConnectOptions) =>
  Effect.gen(function* () {
    // Dials the primary host then each HA fallback from `cfg.fallbacks`, in order. When
    // `--dns-resolver https` is set, each host resolves to all its Cloudflare DoH IPs up front
    // and each is retried in turn; the original hostname is kept as the TLS `servername` so
    // verification still targets it. Local connections use the host verbatim (native resolver).
    const hostList = [{ host: cfg.host, port: cfg.port }, ...(cfg.fallbacks ?? [])];
    const dialTargets: Array<{ dialHost: string; port: number; servername: string | undefined }> =
      [];
    for (const { host, port } of hostList) {
      // Skip DoH for a unix-socket host; resolving a socket path over DNS is meaningless.
      const resolved =
        dnsResolver === "https" && !isLocal && !isUnixSocketHost(host)
          ? yield* resolveHostsOverHttps(host)
          : [host];
      for (const dialHost of resolved) {
        dialTargets.push({ dialHost, port, servername: dialHost === host ? undefined : host });
      }
    }
    // Defaults to 10s remote / 2s local; a DSN or `PGCONNECT_TIMEOUT` value (>0) overrides
    // both. Without this a black-holed host would hang on the OS/driver default.
    const connectTimeoutSeconds = cfg.connectTimeoutSeconds ?? (isLocal ? 2 : 10);
    // Whether the remote step-down runs on this connection; local connections never step down.
    const stepDownRequired = !isLocal && needsRoleStepDown(cfg.user);
    // Uses a self-managed `pg.Pool` rather than `PgClient.make` for two pool behaviors it
    // doesn't expose: `idleTimeoutMillis: 0` (see {@link buildPoolConfig}) and the
    // per-connection step-down `verify` hook (see {@link poolStepDownVerify}). `probe` below
    // runs each attempt in a forked scope so a failed fallback attempt's pool closes
    // immediately, before the next host is dialed.
    const makePool = (
      dialHost: string,
      port: number,
      sslOption: boolean | ConnectionOptions | undefined,
    ) =>
      acquireProbedPool(
        () =>
          new Pg.Pool(
            buildPoolConfig(
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

    // The resolver attaches profile context via `cfg.suggestionContext`; map it here so an
    // actionable hint replaces the generic "--debug" suggestion. The message carries the
    // `failed to connect to postgres:` prefix plus the connection identity and underlying driver
    // cause, not the bare `SqlError` toString, which drops that detail.
    // Loads the `sslrootcert` CA bundle; a missing/unreadable file aborts. Skipped for local
    // connections. Loaded whenever any dial target is non-socket, since a socket primary can
    // still have a TCP fallback that needs it ({@link sslConfigsFor} already plaintexts socket
    // targets).
    const rootcertPath = cfg.sslrootcert;
    const anyTcpTarget = dialTargets.some(({ dialHost }) => !isUnixSocketHost(dialHost));
    const caCert =
      rootcertPath !== undefined && rootcertPath.length > 0 && !isLocal && anyTcpTarget
        ? yield* Effect.try({
            try: () => readFileSync(rootcertPath, "utf8"),
            catch: (error) =>
              new DbConnectError({
                message: `failed to read sslrootcert ${rootcertPath}: ${error}`,
              }),
          })
        : undefined;

    // Loads the client `sslcert`/`sslkey` for cert auth, using the same non-local/TCP gate as
    // the CA bundle; `sslpassword` decrypts an encrypted key. Bound to locals so the narrowing
    // holds in the `Effect.try` closures below.
    const certPath = cfg.sslcert;
    const keyPath = cfg.sslkey;
    const clientCert =
      certPath !== undefined && keyPath !== undefined && !isLocal && anyTcpTarget
        ? {
            cert: yield* Effect.try({
              try: () => readFileSync(certPath, "utf8"),
              catch: (error) =>
                new DbConnectError({
                  message: `failed to read sslcert ${certPath}: ${error}`,
                }),
            }),
            key: yield* Effect.try({
              try: () => readFileSync(keyPath, "utf8"),
              catch: (error) =>
                new DbConnectError({
                  message: `failed to read sslkey ${keyPath}: ${error}`,
                }),
            }),
            ...(cfg.sslpassword !== undefined ? { passphrase: cfg.sslpassword } : {}),
          }
        : undefined;

    // Builds the ordered attempt list: each TLS config from {@link sslConfigsFor} tried against
    // each dial target (host × resolved IPs), with `servername` per target set to the original
    // hostname when dialing a DoH-resolved IP.
    const attempts = dialTargets.flatMap(({ dialHost, port, servername }) =>
      sslConfigsFor(cfg.sslmode, isLocal, servername, caCert, dialHost, clientCert).map((ssl) => ({
        pool: makePool(dialHost, port, ssl),
        // The fallback chain only short-circuits on an auth error when the failed attempt used
        // TLS; a TLS config is any non-plaintext `ssl` value.
        usedTls: ssl !== undefined && ssl !== false,
        rawConfig: buildRawPgConfig(cfg, dialHost, port, ssl, connectTimeoutSeconds),
      })),
    );

    // The `pg` driver connects lazily, so probe every attempt with `select 1` to force the
    // connection, falling through to the next on failure; a terminal SQLSTATE (see
    // {@link isTerminalConnectError}) re-raises instead of masking the primary's failure behind
    // a later host. The final attempt is probed too, since `connect` must return a live session
    // for callers that never run a follow-up query. The winning attempt's `rawConfig` is carried
    // out so `copyToCsv` can reuse the exact dial target the primary connection succeeded against.
    const probe = (attempt: (typeof attempts)[number]) =>
      Effect.gen(function* () {
        // Each attempt's pool runs in its own scope forked from the session scope, so an
        // abandoned winner (e.g. a later step-down failure) still closes when the session scope
        // unwinds. On failure the child scope closes immediately, releasing a losing attempt's
        // pool before the next host is dialed; on success it stays open as a child of the
        // session scope.
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
              isTerminalConnectError(error, attempt.usedTls) ? Effect.fail(error) : next,
            ),
          ),
        probe(attempts[lastIndex]!),
      )
      .pipe(Effect.mapError((error) => toConnectError(cfg, isLocal, error)));

    // Steps down from the temp/privileged login role before any further SQL, remote
    // connections only; a local `--db-url` using `supabase_admin`/`cli_login_*` must not run it.
    // The pool's `verify` hook already ran this on the physical connection, but this explicit
    // one-shot preserves a fail-fast error path. `max: 1` plus `idleTimeoutMillis: 0` keep the
    // connection alive so the role persists for every later `exec`/`query`.
    if (stepDownRequired) {
      yield* Effect.tryPromise({
        try: () => pool.query(SET_SESSION_ROLE),
        catch: (error) => new DbConnectError({ message: `failed to set session role: ${error}` }),
      });
    }

    return { pool, winningRawConfig, stepDownRequired };
  });

/**
 * Acquires a live `pg.Pool` with the same scoped lifecycle and connection behavior as
 * `DbConnection.connect`. The caller owns the surrounding scope; closing it ends the winning
 * pool, while every losing fallback attempt closes before the next target is tried.
 */
export const acquirePgPool = (
  cfg: PgConnInput,
  options: DbConnectOptions,
): Effect.Effect<Pg.Pool, DbConnectError, Scope.Scope> =>
  acquirePgPoolConnection(cfg, options).pipe(Effect.map(({ pool }) => pool));

/**
 * Default `DbConnection` layer, backed by `@effect/sql-pg` (pure-JS `pg` driver, no native
 * addon, so it bundles under `bun build --compile`). Each `connect` builds a scoped
 * single-client connection that closes on scope exit.
 */
const connect = (
  cfg: PgConnInput,
  options: DbConnectOptions,
): Effect.Effect<DbSession, DbConnectError, Scope.Scope> =>
  Effect.gen(function* () {
    const { pool, winningRawConfig, stepDownRequired } = yield* acquirePgPoolConnection(
      cfg,
      options,
    );
    const client = yield* PgClient.fromPool({ acquire: Effect.succeed(pool) }).pipe(
      Effect.provide(Reactivity.layer),
      Effect.mapError((error) => toConnectError(cfg, options.isLocal, error)),
    );

    // `inspect report` runs ~14 `COPY (...) TO STDOUT` statements. node-postgres' COPY protocol
    // needs a raw client, which `@effect/sql-pg` does not surface, so the session opens one
    // dedicated raw connection against the winning dial target and reuses it for every copy.
    // Created lazily on first copy, so `test db`/`inspect db` never open it, and closed by a
    // scope finalizer when the session's scope closes.
    let rawClient: Pg.Client | undefined;
    yield* Effect.addFinalizer(() =>
      rawClient === undefined
        ? Effect.void
        : Effect.promise(() => rawClient!.end().catch(() => {})),
    );
    // A dedicated raw node-postgres client, reused by `copyToCsv` and `queryRaw` since neither
    // is surfaced by `@effect/sql-pg`. Opened lazily against the winning dial target with the
    // same role step-down as the primary session. Establishing this connection is a
    // connection-setup concern, so it fails with `DbConnectError`, not a copy/exec error; only
    // the COPY stream itself raises `DbCopyError`.
    const acquireRawClient = Effect.gen(function* () {
      if (rawClient !== undefined) return rawClient;
      const fresh = new Pg.Client(winningRawConfig);
      // node-postgres emits `error` on a cached client whose socket dies while idle, which
      // crashes the process without a listener; absorb it and drop the dead client so the next
      // acquisition redials.
      fresh.on("error", () => {
        if (rawClient === fresh) rawClient = undefined;
      });
      yield* Effect.tryPromise({
        try: () => fresh.connect(),
        catch: (error) => toConnectError(cfg, options.isLocal, error),
      });
      if (stepDownRequired) {
        yield* Effect.tryPromise({
          try: () => fresh.query(SET_SESSION_ROLE),
          catch: (error) => new DbConnectError({ message: `failed to set session role: ${error}` }),
        });
      }
      rawClient = fresh;
      return fresh;
    });

    // Checking a connection out of the pool for a batch is a connection-setup concern, so it
    // fails with `DbConnectError`, the same classification {@link acquireRawClient} uses: the
    // pool may have to redial, and a refused/auth/DNS failure there is not a statement failure.
    // Mapping it to `DbExecError` would make the migration-apply formatter blame the batch's
    // first statement for a connectivity problem instead.
    const acquireBatchClient = Effect.callback<Pg.PoolClient, DbConnectError>((resume) => {
      let done = false;
      try {
        pool.connect((error, activeClient) => {
          if (done) {
            activeClient?.release();
            return;
          }
          done = true;
          if (error !== undefined) {
            resume(Effect.fail(toConnectError(cfg, options.isLocal, error)));
          } else if (activeClient === undefined) {
            resume(
              Effect.fail(new DbConnectError({ message: "failed to acquire batch connection" })),
            );
          } else {
            resume(Effect.succeed(activeClient));
          }
        });
      } catch (error) {
        done = true;
        resume(Effect.fail(toConnectError(cfg, options.isLocal, error)));
      }
      return Effect.sync(() => {
        done = true;
      });
    });

    const execBatch = (statements: ReadonlyArray<DbBatchStatement>) => {
      if (statements.length === 0) return Effect.void;
      let batchQuery: PgBatchQuery | undefined;
      return Effect.acquireUseRelease(
        Effect.interruptible(acquireBatchClient),
        (activeClient) => {
          const onConnectionError = () => {};
          activeClient.on("error", onConnectionError);
          return Effect.callback<void, DbExecError | DbConnectError>((resume) => {
            let done = false;
            const finish = (error: Error | undefined) => {
              if (done) return;
              done = true;
              if (error === undefined) {
                resume(Effect.void);
                return;
              }
              resume(Effect.fail(batchFailureError(error, batchQuery, options.isLocal)));
            };
            batchQuery = new PgBatchQuery(statements, finish);
            try {
              activeClient.query(batchQuery);
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)));
            }
            return Effect.sync(() => {
              done = true;
            });
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => activeClient.removeListener("error", onConnectionError)),
            ),
          );
        },
        (activeClient, exit) =>
          Effect.sync(() => {
            const discard = shouldDiscardBatchClient(batchQuery, exit);
            activeClient.release(discard ? new Error("batch connection discarded") : undefined);
          }),
      );
    };

    const session: DbSession = {
      ...(stepDownRequired ? { restoreRoleSql: SET_SESSION_ROLE } : {}),
      exec: (sql) => client.unsafe(sql).pipe(Effect.asVoid, Effect.mapError(toExecError)),
      execBatch,
      query: (sql, params) =>
        client.unsafe<Record<string, unknown>>(sql, params).pipe(Effect.mapError(toExecError)),
      extensionExists: (name) =>
        client`select 1 from pg_extension where extname = ${name}`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(toExecError),
        ),
      queryRaw: (sql) =>
        Effect.gen(function* () {
          // `acquireRawClient` fails with `DbConnectError`; surface it verbatim rather than
          // masking a connection failure as "failed to execute query".
          const activeClient = yield* acquireRawClient;
          // Capture the raw command tag from the protocol message directly, since node-postgres'
          // parsed `Result.command` keeps only the first tag word (e.g. "CREATE" for
          // "CREATE TABLE").
          let commandTag = "";
          const onComplete = (msg: { readonly text?: string }) => {
            if (typeof msg.text === "string") commandTag = msg.text;
          };
          activeClient.connection.on("commandComplete", onComplete);
          const result = yield* Effect.tryPromise({
            // `rowMode: "array"` returns rows positionally so duplicate column names survive.
            // `types` keeps date/timestamp/timestamptz cells as raw text to preserve
            // microseconds. `queryMode: "extended"` forces the Parse/Bind/Execute protocol so a
            // multi-statement string is rejected, instead of node-postgres' default simple
            // protocol executing every statement.
            try: () =>
              activeClient.query<Array<unknown>>({
                text: sql,
                queryMode: "extended",
                rowMode: "array",
                types: queryRawTypes,
              }),
            catch: (error) => new DbExecError({ message: `failed to execute query: ${error}` }),
          }).pipe(
            Effect.ensuring(
              Effect.sync(() =>
                activeClient.connection.removeListener("commandComplete", onComplete),
              ),
            ),
          );
          return {
            fields: result.fields.map((field) => field.name),
            // Surface the column type OIDs so the table/CSV formatter can render float4/float8
            // with %g-style formatting while integer columns stay plain.
            fieldTypeIds: result.fields.map((field) => field.dataTypeID),
            rows: result.rows,
            commandTag,
          };
        }),
      copyToCsv: (sql) =>
        Effect.gen(function* () {
          const activeClient = yield* acquireRawClient;
          return yield* Effect.callback<Uint8Array, DbCopyError>((resume) => {
            const stream = activeClient.query(pgCopyTo(sql));
            const chunks: Array<Buffer> = [];
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("error", (error: Error) =>
              resume(Effect.fail(new DbCopyError({ message: `failed to copy output: ${error}` }))),
            );
            stream.on("end", () => resume(Effect.succeed(new Uint8Array(Buffer.concat(chunks)))));
          });
        }),
    };
    return session;
  });

export const dbConnectionSqlPgLayer = Layer.succeed(DbConnection, { connect });
