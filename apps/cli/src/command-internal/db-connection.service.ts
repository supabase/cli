import { Context, type Effect, type Scope } from "effect";
import type { ConnectSuggestionContext } from "./connect-errors.ts";
import type { DbConnectError, DbCopyError, DbExecError } from "./db-connection.errors.ts";

/**
 * Plain Postgres connection parameters. The password is plain here; driver layers wrap it
 * (e.g. `Redacted`) at the boundary.
 */
export interface PgConnInput {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  /**
   * Additional HA failover hosts beyond the primary `host`/`port`, in order — libpq multi-host
   * connection strings (`postgres://h1:5432,h2:5433/db`) dial each in turn. Absent for the
   * common single-host case.
   */
  readonly fallbacks?: ReadonlyArray<{ readonly host: string; readonly port: number }>;
  /**
   * libpq `options` startup parameter. Legacy Supavisor pooler URLs identify the tenant via
   * `?options=reference=<ref>` instead of a `<user>.<ref>` username, so the driver layer must
   * forward this to reach the right tenant. Empty/absent for direct and local connections.
   */
  readonly options?: string;
  /**
   * Additional libpq startup parameters parsed from a `--db-url` (e.g. `search_path`,
   * `statement_timeout`, `application_name`), excluding `options` (carried separately),
   * re-applied so pg-delta introspects with the same session settings. Absent when the DSN
   * carries none.
   */
  readonly runtimeParams?: Readonly<Record<string, string>>;
  /**
   * libpq `sslmode`, parsed from a `--db-url` query string. Controls whether the driver layer
   * negotiates TLS and verifies the server certificate. Absent → TLS without certificate
   * verification (libpq's `prefer`/`require` default).
   */
  readonly sslmode?: string;
  /**
   * libpq `sslrootcert`, from the DSN or `PGSSLROOTCERT`: path to a CA bundle the driver layer
   * loads to verify the server certificate. `sslmode=require` plus a root cert behaves as
   * `verify-ca`. Absent → system roots / no CA pinning.
   */
  readonly sslrootcert?: string;
  /**
   * libpq client-certificate auth, from the DSN or `PGSSLCERT`/`PGSSLKEY`/`PGSSLPASSWORD`.
   * `sslcert`/`sslkey` are file paths loaded into the client cert; `sslpassword` decrypts an
   * encrypted key. The parser only ever sets `sslcert`/`sslkey` as a pair.
   */
  readonly sslcert?: string;
  readonly sslkey?: string;
  readonly sslpassword?: string;
  /**
   * libpq `connect_timeout` in seconds, from the DSN or `PGCONNECT_TIMEOUT`. Only set when
   * explicitly provided and > 0; the driver layer applies its own default otherwise (10s remote,
   * 2s local).
   */
  readonly connectTimeoutSeconds?: number;
  /**
   * Profile context for the connect-failure suggestion. The resolver attaches it so the driver
   * layer can map a refused/auth/IPv6 connect error to an actionable hint. Absent → the driver
   * omits the suggestion (callers fall back to the generic one).
   */
  readonly suggestionContext?: ConnectSuggestionContext;
}

/** A parameter value supported by the extended-protocol batch path. */
export type DbBatchValue = string | ReadonlyArray<string> | null;

/** One statement in an extended-protocol batch. */
export interface DbBatchStatement {
  readonly sql: string;
  readonly params?: ReadonlyArray<DbBatchValue>;
}

/**
 * An open Postgres session. Scoped: the owning `connect` call closes the
 * underlying connection when its `Scope` closes.
 */
export interface DbSession {
  /**
   * SQL that restores the role this session stepped down to after authenticating as a
   * temp/privileged login role. Absent when no step-down ran. File runners re-assert it after
   * each role-reverting statement (a migration's own `RESET ROLE` reverts to the login role, not
   * this one) and before CLI-owned ledger writes. Must stay a fixed, non-user-derived statement.
   */
  readonly restoreRoleSql?: string;
  /** Run a single SQL statement, ignoring any returned rows. */
  readonly exec: (sql: string) => Effect.Effect<void, DbExecError>;
  /**
   * Run statements as one extended-protocol batch with a single final Sync. On failure,
   * {@link DbExecError.statementIndex} is the number of statements that completed before the
   * error.
   *
   * A batch runs on its own pooled connection. Failing to acquire it, or losing it before any of
   * the batch reaches the wire, raises `DbConnectError` instead of `DbExecError`, consistent
   * with {@link queryRaw}.
   */
  readonly execBatch: (
    statements: ReadonlyArray<DbBatchStatement>,
  ) => Effect.Effect<void, DbExecError | DbConnectError>;
  /**
   * Run a parameterized SQL query and return the result rows as plain objects keyed by the
   * query's column names (snake_case is preserved; no row-name transform is applied). Used by
   * the `inspect db` subcommands to render rows as a Glamour table. `params` are bound
   * positionally (`$1`, `$2`, …).
   */
  readonly query: (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, DbExecError>;
  /**
   * Whether an extension named `name` already exists in `pg_extension`, regardless of which
   * schema it lives in. Extensions are global per database, so querying by `extname` alone (not
   * `extname` + `nspname`) avoids treating a pgTAP already installed in another schema (e.g.
   * `public`) as absent and dropping it.
   */
  readonly extensionExists: (name: string) => Effect.Effect<boolean, DbExecError>;
  /**
   * Runs a server-side `COPY (...) TO STDOUT` and returns its raw bytes; `sql` is the
   * already-wrapped COPY statement. Uses one dedicated raw connection, since node-postgres' COPY
   * protocol needs it and `@effect/sql-pg` does not expose one, dialed against the same resolved
   * target as the primary connection and reused for the session. Failing to open it raises
   * `DbConnectError`; the COPY stream itself raises `DbCopyError`.
   */
  readonly copyToCsv: (sql: string) => Effect.Effect<Uint8Array, DbCopyError | DbConnectError>;
  /**
   * Runs a SQL statement and returns its full result metadata for `db query`: ordered column
   * names (`fields`), row values positionally (so duplicate column names survive), and the raw
   * command tag, read directly from the `commandComplete` protocol message since node-postgres
   * otherwise truncates it (e.g. dropping `TABLE` from `CREATE TABLE`). A statement with no
   * result columns returns `fields: []`. Failing to open the connection raises `DbConnectError`;
   * the query itself raises `DbExecError`.
   */
  readonly queryRaw: (sql: string) => Effect.Effect<QueryResult, DbExecError | DbConnectError>;
}

/** Full result metadata for `db query` (see {@link DbSession.queryRaw}). */
export interface QueryResult {
  readonly fields: ReadonlyArray<string>;
  /**
   * Postgres type OID per column. Lets the table/CSV formatter render `float4`/`float8` columns
   * with `%g`-style formatting while integer columns stay plain. Optional so other `queryRaw`
   * callers/mocks need not set it.
   */
  readonly fieldTypeIds?: ReadonlyArray<number>;
  readonly rows: ReadonlyArray<ReadonlyArray<unknown>>;
  readonly commandTag: string;
}

/** Per-connection options the driver layer cannot infer from `cfg` alone. */
export interface DbConnectOptions {
  /**
   * Whether the target is the local stack. Drives TLS: local connections skip TLS entirely,
   * while remote connections require it (without certificate verification, matching libpq's
   * `prefer`/`require` default).
   */
  readonly isLocal: boolean;
  /**
   * The active `--dns-resolver` value. When `"https"` and the connection is remote, the driver
   * resolves the host via Cloudflare DNS-over-HTTPS before dialing; `"native"` (the default) uses
   * the OS resolver. Ignored for local connections.
   */
  readonly dnsResolver: "native" | "https";
}

interface DbConnectionShape {
  readonly connect: (
    cfg: PgConnInput,
    options: DbConnectOptions,
  ) => Effect.Effect<DbSession, DbConnectError, Scope.Scope>;
}

/**
 * Opens raw Postgres connections for commands such as `test db`. The underlying driver is
 * swappable behind this interface; handlers depend only on this service, never on the driver
 * directly.
 */
export class DbConnection extends Context.Service<DbConnection, DbConnectionShape>()(
  "supabase/cli/DbConnection",
) {}
