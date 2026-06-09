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
}

/**
 * An open Postgres session. Scoped: the owning `connect` call closes the
 * underlying connection when its `Scope` closes.
 */
export interface LegacyDbSession {
  /** Run a single SQL statement, ignoring any returned rows. */
  readonly exec: (sql: string) => Effect.Effect<void, LegacyDbExecError>;
  /**
   * Whether `<schema>.<name>` already exists in `pg_extension`.
   *
   * Go keys "did pgTAP already exist?" off a `pgx` `OnNotice` callback (notice
   * code `42710`). `@effect/sql-pg`'s `PgClient` exposes no notice hook, so the
   * legacy port detects pre-existence with this query before enabling — same
   * observable behavior (skip the drop iff it already existed), driver-agnostic.
   * See `apps/cli-go/internal/db/test/test.go:57-78`.
   */
  readonly extensionExists: (
    schema: string,
    name: string,
  ) => Effect.Effect<boolean, LegacyDbExecError>;
}

interface LegacyDbConnectionShape {
  readonly connect: (
    cfg: LegacyPgConnInput,
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
