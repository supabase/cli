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
  /** A connection URL that keeps the query parameters, such as TLS settings, of Analytics' URL. */
  readonly url: string;
}

/** Query parameters node-postgres reads to pick the host or TLS, which a bound endpoint replaces. */
const addressParameters = /^(?:host|port|ssl.*)$/u;

/**
 * Locates Logflare's backend database from Analytics' database URL. A bound database is reached at
 * its endpoint, because the bound URL addresses it from Analytics' runtime; the endpoint is a local
 * port or socket, so TLS settings meant for the runtime's address are dropped.
 */
export const analyticsDatabase = Effect.fnUntraced(function* (
  databaseUrl: string,
  bound: ServiceEndpoint | undefined,
) {
  const backend = yield* backendConnection(databaseUrl);
  const url = new URL(backend.url);
  if (bound === undefined) {
    // node-postgres otherwise reads `sslmode=require` as `verify-full` rather than as libpq does.
    if ([...url.searchParams.keys()].some((name) => name.startsWith("ssl")))
      url.searchParams.set("uselibpqcompat", "true");
    return { url: url.toString() } satisfies AnalyticsDatabase;
  }
  const replaced = Array.from(url.searchParams.keys()).filter((name) =>
    addressParameters.test(name),
  );
  for (const name of replaced) url.searchParams.delete(name);
  // A socket directory is passed as the `host` parameter, which takes precedence over the hostname.
  if (bound.kind === "unix") url.searchParams.set("host", bound.path);
  else url.hostname = bound.host ?? "127.0.0.1";
  url.port = String(bound.port);
  return { url: url.toString() } satisfies AnalyticsDatabase;
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
            url: Redacted.make(connection.url),
            connectTimeout: "2 seconds",
            idleTimeout: "10 seconds",
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
        // A failed query looks the table up again, since a replaced source has a new one.
        const rows = Option.isNone(table)
          ? []
          : yield* withClient(
              (sql) =>
                sql<{ readonly id: string }>`
                  SELECT id::text AS id FROM ${sql(schema)}.${sql(table.value)} WHERE id IN ${sql.in(ids)}`,
            ).pipe(Effect.tapError(() => Cache.invalidate(tables, source)));
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
