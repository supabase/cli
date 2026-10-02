import { PgClient } from "@effect/sql-pg";
import {
  Cache,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  RcRef,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { failureMessage } from "../internal/failure-message.ts";
import { backendConnection, schema } from "../services/Analytics.ts";
import type { ServiceEndpoint } from "../services/Recipe.ts";
import { StoredEventsError, type StoredEvents } from "./LogForwarder.ts";

/** The database Analytics' Postgres backend writes to, as the host reaches it. */
export interface AnalyticsDatabase {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

/**
 * Locates Logflare's backend database from Analytics' database URL. A bound database is reached at
 * its endpoint, because the bound URL addresses it from Analytics' runtime.
 */
export const analyticsDatabase = Effect.fnUntraced(function* (
  databaseUrl: string,
  bound: ServiceEndpoint | undefined,
) {
  const backend = yield* backendConnection(databaseUrl);
  return {
    host:
      bound === undefined
        ? backend.host
        : ((bound.kind === "unix" ? bound.path : bound.host) ?? "127.0.0.1"),
    port: bound === undefined ? Number(backend.port) : bound.port,
    database: backend.database,
    username: backend.username,
    password: backend.password,
  } satisfies AnalyticsDatabase;
});

/** A source token with `-` replaced by `_`, as Logflare names its event tables. */
const tablePattern = /^log_events_[0-9a-f]{8}(?:_[0-9a-f]{4}){3}_[0-9a-f]{12}$/u;

/**
 * Reads stored event ids from the `log_events_<token>` table Logflare's Postgres backend keeps per
 * source. This couples to Logflare's private table layout, which the owner's Analytics
 * integration test pins. Failures are retried by the caller and warned about once per outage.
 */
export const make = Effect.fn("LogflareStorage.make")(function* <E>(
  database: Effect.Effect<AnalyticsDatabase, E>,
) {
  const client = yield* RcRef.make({
    acquire: database.pipe(
      Effect.flatMap((connection) =>
        Layer.build(
          PgClient.layer({
            host: connection.host,
            port: connection.port,
            database: connection.database,
            username: connection.username,
            password: Redacted.make(connection.password),
            connectTimeout: "2 seconds",
          }),
        ),
      ),
      Effect.map((context) => Context.get(context, PgClient.PgClient)),
      Effect.mapError(
        (cause) =>
          new StoredEventsError({
            message: `Unable to reach the database Analytics stores events in: ${failureMessage(cause)}`,
            cause,
          }),
      ),
    ),
    idleTimeToLive: Duration.infinity,
  });
  // A failed query can mean the database moved, so the next one connects again.
  const withClient = <A, E2>(run: (sql: PgClient.PgClient) => Effect.Effect<A, E2>) =>
    Effect.scoped(RcRef.get(client).pipe(Effect.flatMap(run))).pipe(
      Effect.tapError(() => RcRef.invalidate(client)),
    );

  // Only a source Analytics knows answers for its events; its table appears once Analytics uses it.
  const tables = yield* Cache.makeWith(
    (source: string) =>
      withClient(
        (sql) =>
          sql<{ readonly name: string; readonly created: boolean }>`
          SELECT 'log_events_' || replace(token::text, '-', '_') AS name,
            to_regclass(format('%I.%I', ${schema}::text, 'log_events_' || replace(token::text, '-', '_'))) IS NOT NULL AS created
          FROM ${sql(schema)}.sources
          WHERE name = ${source}
          LIMIT 2`,
      ).pipe(
        Effect.flatMap((rows) => {
          const [row] = rows;
          if (row === undefined || rows.length > 1)
            return Effect.fail(
              new StoredEventsError({
                message: `Analytics has ${row === undefined ? "no" : "several"} ${source} sources`,
              }),
            );
          if (!tablePattern.test(row.name))
            return Effect.fail(
              new StoredEventsError({ message: `Unexpected Analytics table name ${row.name}` }),
            );
          return Effect.succeed(row.created ? Option.some(row.name) : Option.none<string>());
        }),
      ),
    {
      capacity: 64,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && Option.isSome(exit.value) ? Duration.infinity : Duration.zero,
    },
  );
  const warned = yield* Ref.make(false);

  return {
    storedIds: Effect.fn("LogflareStorage.storedIds")(
      function* (source: string, ids: ReadonlyArray<string>) {
        yield* Effect.annotateCurrentSpan({ source, requested_count: ids.length });
        if (ids.length === 0) return new Set<string>();
        const table = yield* Cache.get(tables, source);
        yield* Effect.annotateCurrentSpan({ table_found: Option.isSome(table) });
        const rows = Option.isNone(table)
          ? []
          : yield* withClient(
              (sql) =>
                sql<{ readonly id: string }>`
                  SELECT id::text AS id FROM ${sql(schema)}.${sql(table.value)} WHERE id IN ${sql.in(ids)}`,
            );
        yield* Effect.annotateCurrentSpan({ stored_count: rows.length });
        return new Set(rows.map(({ id }) => id));
      },
      (effect, source) =>
        effect.pipe(
          Effect.mapError((cause) =>
            Schema.is(StoredEventsError)(cause)
              ? cause
              : new StoredEventsError({
                  message: `Unable to read stored ${source} events: ${failureMessage(cause)}`,
                  cause,
                }),
          ),
          Effect.tapError((error) =>
            Ref.getAndSet(warned, true).pipe(
              Effect.flatMap((already) =>
                already
                  ? Effect.void
                  : Effect.logWarning(
                      `Log shipping waits until Analytics' stored events can be read: ${error.message}`,
                    ),
              ),
            ),
          ),
          Effect.tap(() => Ref.set(warned, false)),
        ),
    ),
  } satisfies StoredEvents;
});
