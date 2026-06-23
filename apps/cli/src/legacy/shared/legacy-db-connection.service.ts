import { Context, type Effect, type Scope } from "effect";
import type {
  LegacyDbConnectError,
  LegacyDbCopyError,
  LegacyDbExecError,
} from "./legacy-db-connection.errors.ts";

/**
 * Plain Postgres connection parameters, mirroring Go's `pgconn.Config`
 * (`apps/cli-go/internal/utils/flags/db_url.go`). The password is plain here;
 * driver layers wrap it (e.g. `Redacted`) at the boundary.
 */
export interface LegacyPgConnInput {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  /**
   * Additional HA failover hosts beyond the primary `host`/`port`, in order.
   * pgconn accepts libpq multi-host connection strings
   * (`postgres://h1:5432,h2:5433/db` or `host=h1,h2 port=5432,5433`) and dials
   * each in turn (`config.go:326-362`). `host`/`port` are the *primary*
   * (`config.Host`/`config.Port`, used for `IsLocalDatabase` and `.pgpass`); these
   * are the remaining `config.Fallbacks`. Absent for the common single-host case.
   */
  readonly fallbacks?: ReadonlyArray<{ readonly host: string; readonly port: number }>;
  /**
   * libpq `options` startup parameter (Go's `pgconn.Config.RuntimeParams["options"]`).
   * Legacy Supavisor pooler URLs identify the tenant via `?options=reference=<ref>`
   * instead of a `<user>.<ref>` username; the driver layer must forward this so the
   * connection reaches the right tenant. Empty/absent for direct and local connections.
   */
  readonly options?: string;
  /**
   * Additional libpq startup `RuntimeParams` parsed from a `--db-url` (e.g.
   * `search_path`, `statement_timeout`, `application_name`) — every connection-string
   * setting except pgconn's `notRuntimeParams` and `options` (carried separately). Go's
   * `ToPostgresURL` re-appends all of these, so pg-delta introspects with the same
   * session settings. Absent when the DSN carries none.
   */
  readonly runtimeParams?: Readonly<Record<string, string>>;
  /**
   * libpq `sslmode` (Go's `pgconn.Config` TLS mode, parsed by `pgconn.ParseConfig`
   * from a `--db-url` query string). Controls whether the driver layer negotiates
   * TLS and whether it verifies the server certificate. Absent → the remote default
   * (TLS without certificate verification, matching pgx's `prefer`/`require`).
   */
  readonly sslmode?: string;
  /**
   * libpq `sslrootcert` (Go's `pgconn.Config` `TLSConfig.RootCAs`, from the DSN
   * or `PGSSLROOTCERT`): path to a CA bundle the driver layer loads to verify the
   * server certificate. pgconn treats `sslmode=require` + a root cert as
   * `verify-ca`. Absent → system roots / no CA pinning.
   */
  readonly sslrootcert?: string;
  /**
   * libpq client-certificate auth (Go's `pgconn.Config` `TLSConfig.Certificates`,
   * from the DSN or `PGSSLCERT`/`PGSSLKEY`/`PGSSLPASSWORD`). `sslcert`/`sslkey` are
   * file paths loaded by the driver layer into the client cert; `sslpassword`
   * decrypts an encrypted key. pgconn requires both `sslcert` and `sslkey` together
   * (`config.go:710-711`), so the parser only ever sets them as a pair.
   */
  readonly sslcert?: string;
  readonly sslkey?: string;
  readonly sslpassword?: string;
  /**
   * libpq `connect_timeout` in seconds (Go's `pgconn.Config.ConnectTimeout`, from
   * the DSN or `PGCONNECT_TIMEOUT`). Only set when explicitly provided and > 0; the
   * driver layer applies Go's default otherwise (10s remote, 2s local — see
   * `ToPostgresURL`/`ConnectLocalPostgres`).
   */
  readonly connectTimeoutSeconds?: number;
}

/**
 * An open Postgres session. Scoped: the owning `connect` call closes the
 * underlying connection when its `Scope` closes.
 */
export interface LegacyDbSession {
  /** Run a single SQL statement, ignoring any returned rows. */
  readonly exec: (sql: string) => Effect.Effect<void, LegacyDbExecError>;
  /**
   * Run a parameterized SQL query and return the result rows as plain objects
   * keyed by the query's column names (snake_case is preserved — the driver
   * layer applies no row-name transform, mirroring Go's `pgxv5.CollectRows`).
   *
   * Used by the `inspect db` subcommands, which each embed a SQL file and render
   * the rows as a Glamour table. `params` are bound positionally (`$1`, `$2`, …),
   * matching Go's `conn.Query(ctx, sql, args...)`.
   */
  readonly query: (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, LegacyDbExecError>;
  /**
   * Whether an extension named `name` already exists in `pg_extension`,
   * **regardless of which schema it lives in**.
   *
   * Go keys "did pgTAP already exist?" off a `pgx` `OnNotice` callback (notice
   * code `42710`, `duplicate_object`). That notice fires whenever
   * `CREATE EXTENSION IF NOT EXISTS pgtap ...` finds the extension already
   * installed — extensions are global per-database, so the schema is irrelevant.
   * `@effect/sql-pg`'s `PgClient` exposes no notice hook, so the legacy port
   * detects pre-existence with this query before enabling. Querying by `extname`
   * only (not `extname` + `nspname`) matches Go: it must not drop a pgTAP the user
   * pre-installed in another schema such as `public`.
   * See `apps/cli-go/internal/db/test/test.go:57-78`.
   */
  readonly extensionExists: (name: string) => Effect.Effect<boolean, LegacyDbExecError>;
  /**
   * Run a server-side `COPY (...) TO STDOUT` and return its raw bytes. Mirrors
   * Go's `copyToCSV` (`apps/cli-go/internal/inspect/report.go:64-77`), which
   * streams `pgconn.CopyTo` into a file. `sql` is the already-wrapped COPY
   * statement (e.g. `COPY (<query>) TO STDOUT WITH CSV HEADER`); the driver does
   * not wrap it. Used by `inspect report` to produce byte-identical CSVs by
   * construction (the server serializes the values, never the TS side).
   *
   * The driver opens ONE dedicated raw connection (node-postgres' COPY protocol
   * needs the raw client, which `@effect/sql-pg` does not expose) against the same
   * resolved dial target the primary connection won — so TLS / fallback / DoH
   * parity is preserved — and reuses it for every copy, matching Go's single
   * `pgconn` for all report queries. The connection is opened lazily on the first
   * copy and closed when the owning session's scope closes. Failing to establish
   * that connection raises `LegacyDbConnectError` (a connection-setup failure,
   * matching Go); only the COPY stream itself raises `LegacyDbCopyError`.
   */
  readonly copyToCsv: (
    sql: string,
  ) => Effect.Effect<Uint8Array, LegacyDbCopyError | LegacyDbConnectError>;
  /**
   * Run a SQL statement and return its full result metadata, mirroring Go's
   * `pgx.Rows` surface used by `db query` (`apps/cli-go/internal/db/query/query.go`):
   * the ordered column names (`fields`), the row values **positionally** (so
   * duplicate column names survive — node-postgres `rowMode: "array"`), and the
   * raw command tag (`rows.CommandTag()`, e.g. `INSERT 0 1`, `CREATE TABLE`).
   *
   * A statement with no result columns (DDL/DML) returns `fields: []`; the caller
   * prints `commandTag`. `@effect/sql-pg` exposes none of this (it returns row
   * objects only), so the driver runs the query on a dedicated raw `pg` client —
   * the same one `copyToCsv` uses — and captures the command tag from the
   * `commandComplete` protocol message (node-postgres otherwise keeps only the
   * first tag word, losing e.g. the `TABLE` in `CREATE TABLE`).
   *
   * Failing to establish that shared raw connection raises `LegacyDbConnectError`
   * (a connection-setup failure, surfaced verbatim — not masked as an exec
   * error), consistent with {@link copyToCsv}; the query itself raises
   * `LegacyDbExecError`.
   */
  readonly queryRaw: (
    sql: string,
  ) => Effect.Effect<LegacyQueryResult, LegacyDbExecError | LegacyDbConnectError>;
}

/** Full result metadata for `db query` (see {@link LegacyDbSession.queryRaw}). */
export interface LegacyQueryResult {
  readonly fields: ReadonlyArray<string>;
  /**
   * Postgres type OID per column (node-postgres `FieldDef.dataTypeID`). Lets the
   * local/`--db-url` table/CSV formatter render `float4`/`float8` columns with Go's
   * `%g` while integer columns stay plain — Go scans by field type
   * (`internal/db/query`). Optional so other `queryRaw` callers/mocks need not set it.
   */
  readonly fieldTypeIds?: ReadonlyArray<number>;
  readonly rows: ReadonlyArray<ReadonlyArray<unknown>>;
  readonly commandTag: string;
}

/** Per-connection options the driver layer cannot infer from `cfg` alone. */
export interface LegacyDbConnectOptions {
  /**
   * Whether the target is the local stack (Go's `utils.IsLocalDatabase`). Drives
   * TLS, mirroring Go (`apps/cli-go/internal/utils/connect.go`): local connections
   * set `cc.TLSConfig = nil` (`ConnectLocalPostgres`) → no TLS, while remote
   * connections go through `ConnectByUrl`, where pgx defaults to `sslmode=prefer`
   * and every non-TLS fallback is stripped → TLS is required (without certificate
   * verification, matching pgx's default for `prefer`/`require`).
   */
  readonly isLocal: boolean;
  /**
   * The active `--dns-resolver` value (Go's `utils.DNSResolver.Value`). When
   * `"https"` and the connection is remote, the driver resolves the host via
   * Cloudflare DNS-over-HTTPS before dialing, mirroring Go's
   * `cc.LookupFunc = FallbackLookupIP` (`connect.go:211-213`). `"native"` (the
   * default) uses the OS resolver. Ignored for local connections, matching Go.
   */
  readonly dnsResolver: "native" | "https";
}

interface LegacyDbConnectionShape {
  readonly connect: (
    cfg: LegacyPgConnInput,
    options: LegacyDbConnectOptions,
  ) => Effect.Effect<LegacyDbSession, LegacyDbConnectError, Scope.Scope>;
}

/**
 * Opens raw Postgres connections for legacy commands (`test db`, and later
 * `db reset` / `db dump`). The underlying driver is swappable behind this
 * interface — the default is `@effect/sql-pg`; a Bun.SQL fallback exists with
 * the same shape. Handlers depend only on this service, never on the driver.
 */
export class LegacyDbConnection extends Context.Service<
  LegacyDbConnection,
  LegacyDbConnectionShape
>()("supabase/legacy/DbConnection") {}
