import { legacyDbConnectionSqlPgLayer } from "./legacy-db-connection.sql-pg.layer.ts";

/**
 * The active `LegacyDbConnection` layer — the single swap point for the
 * Postgres driver. It re-exports the `@effect/sql-pg` layer, which is verified
 * to bundle and round-trip under `bun build --compile` (CLI-1318 spike). All
 * call sites import this name, not the driver, so swapping the implementation
 * (e.g. to a Bun.SQL-backed layer) is a one-line change here.
 */
export const legacyDbConnectionLayer = legacyDbConnectionSqlPgLayer;
