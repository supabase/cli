import { dbConnectionSqlPgLayer } from "./db-connection.sql-pg.layer.ts";

/**
 * The active `DbConnection` layer. Re-exports the `@effect/sql-pg` layer; call sites import this
 * name, not the driver, so swapping the implementation is a one-line change here.
 */
export const dbConnectionLayer = dbConnectionSqlPgLayer;
