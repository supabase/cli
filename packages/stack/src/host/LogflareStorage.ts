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
  Schema,
} from "effect";
import { failureMessage } from "../internal/failure-message.ts";
import { schema } from "../services/Analytics.ts";
import { StoredEventsError, type StoredEvents } from "./LogForwarder.ts";

/** The Postgres database Analytics' Postgres backend writes to, reachable from the host. */
export interface AnalyticsDatabase {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string | undefined;
  readonly password: string | undefined;
}

/** A source token with `-` replaced by `_`, as Logflare names its event tables. */
const tablePattern = /^log_events_[0-9a-f]{8}(?:_[0-9a-f]{4}){3}_[0-9a-f]{12}$/u;

/**
 * Reads stored event ids from the `log_events_<token>` table Logflare's Postgres backend keeps per
 * source. This couples to Logflare's private table layout, which the owner's Analytics
 * integration test pins.
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
            password:
              connection.password === undefined ? undefined : Redacted.make(connection.password),
            connectTimeout: "2 seconds",
          }),
        ),
      ),
      Effect.map((context) => Context.get(context, PgClient.PgClient)),
    ),
    idleTimeToLive: Duration.infinity,
  });
  const withClient = <A, E2>(run: (sql: PgClient.PgClient) => Effect.Effect<A, E2>) =>
    Effect.scoped(RcRef.get(client).pipe(Effect.flatMap(run)));

  // A source or table Analytics has not created yet holds no events and is looked up again.
  const tables = yield* Cache.makeWith(
    (source: string) =>
      withClient(
        (sql) =>
          sql<{ readonly name: string }>`
          SELECT 'log_events_' || replace(token::text, '-', '_') AS name
          FROM ${sql(schema)}.sources
          WHERE name = ${source}
            AND to_regclass(format('%I.%I', ${schema}::text, 'log_events_' || replace(token::text, '-', '_'))) IS NOT NULL`,
      ).pipe(
        Effect.flatMap(([row]) => {
          if (row === undefined) return Effect.succeed(Option.none<string>());
          return tablePattern.test(row.name)
            ? Effect.succeed(Option.some(row.name))
            : Effect.fail(
                new StoredEventsError({ message: `Unexpected Analytics table name ${row.name}` }),
              );
        }),
      ),
    {
      capacity: 64,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && Option.isSome(exit.value) ? Duration.infinity : Duration.zero,
    },
  );

  return {
    storedIds: (source, ids) =>
      Effect.gen(function* () {
        if (ids.length === 0) return new Set<string>();
        const table = yield* Cache.get(tables, source);
        if (Option.isNone(table)) return new Set<string>();
        const rows = yield* withClient(
          (sql) =>
            sql<{ readonly id: string }>`
              SELECT id::text AS id FROM ${sql(schema)}.${sql(table.value)} WHERE id IN ${sql.in(ids)}`,
        );
        return new Set(rows.map(({ id }) => id));
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(StoredEventsError)(cause)
            ? cause
            : new StoredEventsError({
                message: `Unable to read stored ${source} events: ${failureMessage(cause)}`,
                cause,
              }),
        ),
      ),
  } satisfies StoredEvents;
});
