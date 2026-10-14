import { PgClient } from "@effect/sql-pg";
import { Effect, Stream } from "effect";
import type * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlConnection from "effect/sql/SqlConnection";
import {
  AuthenticationError,
  AuthorizationError,
  ConnectionError,
  ConstraintError,
  DeadlockError,
  LockTimeoutError,
  SerializationError,
  SqlError,
  SqlSyntaxError,
  StatementTimeoutError,
  UniqueViolation,
  UnknownError,
} from "effect/sql/SqlError";
import type * as Pg from "pg";

/**
 * Builds an Effect SQL client over a caller-owned node-postgres pool. `@effect/sql-pg` ships a
 * native client with no pool bridge, while the CLI keeps node-postgres for the pool behaviors
 * `db-connection.sql-pg.layer.ts` relies on: a zero idle timeout, the per-connection role
 * step-down hook, and raw COPY connections.
 */
export const makePoolSqlClient = (
  pool: Pg.Pool,
): Effect.Effect<SqlClient.SqlClient, never, Reactivity.Reactivity> =>
  SqlClient.make({
    acquirer: Effect.succeed(new PoolConnection(pool)),
    compiler: PgClient.makeCompiler(),
    spanAttributes: [
      ["db.system.name", "postgresql"],
      ["db.namespace", pool.options.database ?? pool.options.user ?? "postgres"],
      ["server.address", pool.options.host ?? "localhost"],
      ["server.port", pool.options.port ?? 5432],
    ],
  });

type TransformRows = (<A extends object>(rows: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined;

class PoolConnection implements SqlConnection.Connection {
  constructor(private readonly pool: Pg.Pool) {}

  private withClient<A>(
    f: (client: Pg.ClientBase, resume: (_: Effect.Effect<A, SqlError>) => void) => void,
  ): Effect.Effect<A, SqlError> {
    const pool = this.pool;
    return Effect.callback<A, SqlError>((resume) => {
      let done = false;
      let cancel: Effect.Effect<void> | undefined;
      let client: Pg.PoolClient | undefined;
      const onError = (cause: Error) => {
        cleanup(cause);
        resume(
          Effect.fail(
            new SqlError({
              reason: classifyError(cause, "Connection error", "acquireConnection"),
            }),
          ),
        );
      };
      const cleanup = (cause?: Error) => {
        if (!done) client?.release(cause);
        done = true;
        client?.off("error", onError);
      };
      pool.connect((cause, acquired) => {
        if (cause) {
          return resume(
            Effect.fail(
              new SqlError({
                reason: classifyError(cause, "Failed to acquire connection", "acquireConnection"),
              }),
            ),
          );
        }
        if (!acquired) {
          return resume(
            Effect.fail(
              new SqlError({
                reason: new ConnectionError({
                  message: "Failed to acquire connection",
                  cause: new Error("No client returned"),
                  operation: "acquireConnection",
                }),
              }),
            ),
          );
        }
        if (done) {
          acquired.release();
          return;
        }
        client = acquired;
        client.once("error", onError);
        cancel = makeCancel(pool, client);
        f(client, (effect) => {
          cleanup();
          resume(effect);
        });
      });
      return Effect.suspend(() => {
        if (!cancel) {
          cleanup();
          return Effect.void;
        }
        return Effect.ensuring(cancel, Effect.sync(cleanup));
      });
    });
  }

  private run(query: string, params: ReadonlyArray<unknown>) {
    return this.withClient<ReadonlyArray<any>>((client, resume) => {
      client.query(query, params as Array<unknown>, (err, result) => {
        if (err) {
          resume(
            Effect.fail(
              new SqlError({
                reason: classifyError(err, "Failed to execute statement", "execute"),
              }),
            ),
          );
        } else {
          resume(
            Effect.succeed(
              Array.isArray(result) ? result.map((r) => r.rows ?? []) : (result.rows ?? []),
            ),
          );
        }
      });
    });
  }

  execute(sql: string, params: ReadonlyArray<unknown>, transformRows: TransformRows) {
    return transformRows ? Effect.map(this.run(sql, params), transformRows) : this.run(sql, params);
  }

  executeRaw(sql: string, params: ReadonlyArray<unknown>) {
    return this.withClient<Pg.QueryResult>((client, resume) => {
      client.query(sql, params as Array<unknown>, (err, result) => {
        if (err) {
          resume(
            Effect.fail(
              new SqlError({
                reason: classifyError(err, "Failed to execute statement", "execute"),
              }),
            ),
          );
        } else {
          resume(Effect.succeed(result));
        }
      });
    });
  }

  executeValues(sql: string, params: ReadonlyArray<unknown>) {
    return this.withClient<ReadonlyArray<ReadonlyArray<unknown>>>((client, resume) => {
      client.query(
        { text: sql, rowMode: "array", values: params as Array<unknown> },
        (err, result) => {
          if (err) {
            resume(
              Effect.fail(
                new SqlError({
                  reason: classifyError(err, "Failed to execute statement", "execute"),
                }),
              ),
            );
          } else {
            resume(Effect.succeed(result.rows));
          }
        },
      );
    });
  }

  executeValuesUnprepared(sql: string, params: ReadonlyArray<unknown>) {
    return this.executeValues(sql, params);
  }

  executeUnprepared(sql: string, params: ReadonlyArray<unknown>, transformRows: TransformRows) {
    return this.execute(sql, params, transformRows);
  }

  executeStream(sql: string, params: ReadonlyArray<unknown>, transformRows: TransformRows) {
    return Stream.unwrap(
      Effect.map(this.execute(sql, params, transformRows), (rows) => Stream.fromArray(rows)),
    );
  }
}

const cancelEffects = new WeakMap<Pg.PoolClient, Effect.Effect<void> | undefined>();

/** Best-effort `pg_cancel_backend` for an interrupted statement. */
const makeCancel = (pool: Pg.Pool, client: Pg.PoolClient) => {
  if (cancelEffects.has(client)) return cancelEffects.get(client);
  const processId: unknown = Reflect.get(client, "processID");
  const effect =
    typeof processId === "number"
      ? Effect.callback<void>((resume) => {
          if (pool.ending) return resume(Effect.void);
          pool.query(`SELECT pg_cancel_backend(${processId})`, () => {
            resume(Effect.void);
          });
        }).pipe(Effect.interruptible, Effect.timeoutOption(5000), Effect.asVoid)
      : undefined;
  cancelEffects.set(client, effect);
  return effect;
};

const pgCodeFromCause = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
};

const pgConstraintFromCause = (cause: unknown): string => {
  if (typeof cause !== "object" || cause === null || !("constraint" in cause)) return "unknown";
  const constraint = cause.constraint;
  if (typeof constraint !== "string") return "unknown";
  const normalized = constraint.trim();
  return normalized.length === 0 ? "unknown" : normalized;
};

/** Maps a node-postgres error to the `SqlError` reason the `@effect/sql-pg` bridge used to raise. */
const classifyError = (cause: unknown, message: string, operation: string) => {
  const props = { cause, message, operation };
  const code = pgCodeFromCause(cause);
  if (code !== undefined) {
    if (code.startsWith("08")) return new ConnectionError(props);
    if (code.startsWith("28")) return new AuthenticationError(props);
    if (code === "42501") return new AuthorizationError(props);
    if (code.startsWith("42")) return new SqlSyntaxError(props);
    if (code === "23505") {
      return new UniqueViolation({ ...props, constraint: pgConstraintFromCause(cause) });
    }
    if (code.startsWith("23")) return new ConstraintError(props);
    if (code === "40P01") return new DeadlockError(props);
    if (code === "40001") return new SerializationError(props);
    if (code === "55P03") return new LockTimeoutError(props);
    if (code === "57014") return new StatementTimeoutError(props);
  }
  return new UnknownError(props);
};
