import { Context, type Effect, type Scope } from "effect";
import type { LegacyDbConnectError, LegacyDbExecError } from "./legacy-db-connection.errors.ts";

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
   * libpq `options` startup parameter (Go's `pgconn.Config.RuntimeParams["options"]`).
   * Legacy Supavisor pooler URLs identify the tenant via `?options=reference=<ref>`
   * instead of a `<user>.<ref>` username; the driver layer must forward this so the
   * connection reaches the right tenant. Empty/absent for direct and local connections.
   */
  readonly options?: string;
  /**
   * libpq `sslmode` (Go's `pgconn.Config` TLS mode, parsed by `pgconn.ParseConfig`
   * from a `--db-url` query string). Controls whether the driver layer negotiates
   * TLS and whether it verifies the server certificate. Absent → the remote default
   * (TLS without certificate verification, matching pgx's `prefer`/`require`).
   */
  readonly sslmode?: string;
}

/**
 * An open Postgres session. Scoped: the owning `connect` call closes the
 * underlying connection when its `Scope` closes.
 */
export interface LegacyDbSession {
  /** Run a single SQL statement, ignoring any returned rows. */
  readonly exec: (sql: string) => Effect.Effect<void, LegacyDbExecError>;
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
