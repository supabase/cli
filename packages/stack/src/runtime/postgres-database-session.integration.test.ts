import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Redacted, Ref } from "effect";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import {
  makeDatabaseSessionFromAcquisition,
  makeDatabaseSessionFromSqlClient,
  type DatabaseSqlClient,
} from "./PostgresDatabaseSession.ts";

describe("Postgres database session", () => {
  it.live("uses parameterized format calls for role and database settings", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly sql: string; readonly params: ReadonlyArray<unknown> }> = [];
      const client: DatabaseSqlClient = {
        unsafe: (sql, params = []) =>
          Effect.sync(() => {
            calls.push({ sql, params });
            if (sql.startsWith("SELECT format"))
              return [{ statement: "ALTER ROLE postgres PASSWORD 'database-secret'" }];
            return [];
          }),
        withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      };
      const session = makeDatabaseSessionFromSqlClient(client);
      yield* session.transaction((transaction) =>
        Effect.gen(function* () {
          yield* transaction.setRolePassword("postgres", Redacted.make("database-secret"));
          yield* transaction.setDatabaseSetting({
            name: "app.settings.jwt_secret",
            value: Redacted.make("jwt-secret"),
          });
          yield* transaction.setDatabaseSetting({ name: "app.settings.jwt_exp", value: 3600 });
        }),
      );
      expect(calls[0]).toEqual({
        sql: "SELECT format('ALTER ROLE %I PASSWORD %L', $1, $2) AS statement",
        params: ["postgres", "database-secret"],
      });
      expect(calls[1]?.sql).toContain("ALTER ROLE postgres PASSWORD");
      expect(calls[2]).toEqual({
        sql: "SELECT format('ALTER DATABASE postgres SET %I TO %L', $1, $2) AS statement",
        params: ["app.settings.jwt_secret", "jwt-secret"],
      });
      expect(calls[4]).toEqual({
        sql: "SELECT format('ALTER DATABASE postgres SET %I TO %L', $1, $2) AS statement",
        params: ["app.settings.jwt_exp", 3600],
      });
    }),
  );

  it.live("does not leak generated secret SQL through mapped failures", () =>
    Effect.gen(function* () {
      const client: DatabaseSqlClient = {
        unsafe: (sql) =>
          sql.startsWith("SELECT format")
            ? Effect.succeed([{ statement: "ALTER ROLE postgres PASSWORD 'database-secret'" }])
            : Effect.fail(
                new SqlError({
                  reason: new UnknownError({
                    message: "generated ALTER ROLE contains database-secret",
                    cause: new Error("generated ALTER ROLE contains database-secret"),
                  }),
                }),
              ),
        withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      };
      const result = yield* makeDatabaseSessionFromSqlClient(client)
        .transaction((transaction) =>
          transaction.setRolePassword("postgres", Redacted.make("database-secret")),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.pretty(result.cause)).not.toContain("database-secret");
    }),
  );

  it.live("keeps an acquired client live until the caller scope closes", () =>
    Effect.gen(function* () {
      const released = yield* Ref.make(false);
      const client: DatabaseSqlClient = {
        unsafe: () => Effect.succeed([]),
        withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeDatabaseSessionFromAcquisition(
            Effect.acquireRelease(Effect.succeed(client), () => Ref.set(released, true)),
          );
          yield* session.execute("SELECT 1");
          expect(yield* Ref.get(released)).toBe(false);
        }),
      );
      expect(yield* Ref.get(released)).toBe(true);
    }),
  );
});
