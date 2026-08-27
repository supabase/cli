import { Effect, FileSystem, Layer, Path } from "effect";
import type { Pool, PoolClient } from "pg";
import { Output } from "../../shared/output/output.service.ts";
import {
  SchemaEngineError,
  SchemaHistoryConflictError,
  SchemaMigrationsPrivilegeError,
} from "../../shared/schema/schema-errors.ts";
import { formatHistoryConflict } from "../../shared/migrations/migration-repair-suggest.ts";
import {
  MigrationRunner,
  type MigrationApplyResult,
  type MigrationHistoryRow,
  type MigrationHistoryStatementsRow,
} from "../../shared/migrations/migration-runner.service.ts";
import { PLATFORM_SEARCH_PATH_SQL } from "../../shared/database/database-pool.ts";
import { LegacyDbConnectError, LegacyDbExecError } from "../shared/legacy-db-connection.errors.ts";
import { LegacyMigrationsReadError } from "../shared/legacy-migration.errors.ts";
import type { LegacyDbSession } from "../shared/legacy-db-connection.service.ts";
import { legacyApplyMigrations } from "../shared/legacy-migration-apply.ts";
import {
  INSERT_MIGRATION_VERSION,
  legacyCreateMigrationTable,
  legacyListRemoteMigrations,
} from "../shared/legacy-migration-history.ts";

const engineError = (detail: string) =>
  new SchemaEngineError({
    detail,
    suggestion: "Check the database connection and migration SQL, then retry.",
  });

const MIGRATIONS_PRIVILEGE_DENIED = /permission denied for schema supabase_migrations/iu;

const privilegeError = (detail: string) =>
  new SchemaMigrationsPrivilegeError({
    detail,
    suggestion: "Set SUPABASE_DB_PASSWORD for the postgres role, then retry.",
  });

const isMigrationsPrivilegeDenied = (message: string, code?: string): boolean =>
  MIGRATIONS_PRIVILEGE_DENIED.test(message) && (code === undefined || code === "42501");

const postgresErrorCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  const { code } = cause;
  return typeof code === "string" ? code : undefined;
};

const toRunnerErrorFromCause = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = postgresErrorCode(cause);
  if (isMigrationsPrivilegeDenied(message, code)) return privilegeError(message);
  return engineError(message);
};

type RunnerConnectError =
  | SchemaEngineError
  | SchemaMigrationsPrivilegeError
  | LegacyDbConnectError
  | LegacyDbExecError
  | LegacyMigrationsReadError;

const mapConnectError = (error: RunnerConnectError) => {
  if (error instanceof SchemaMigrationsPrivilegeError) return error;
  const code = error instanceof LegacyDbExecError ? error.code : undefined;
  if (isMigrationsPrivilegeDenied(error.message, code)) return privilegeError(error.message);
  return error instanceof SchemaEngineError ? error : engineError(error.message);
};

const toExecError = (cause: unknown, statementIndex?: number) =>
  new LegacyDbExecError({
    message: cause instanceof Error ? cause.message : String(cause),
    ...(postgresErrorCode(cause) !== undefined ? { code: postgresErrorCode(cause) } : {}),
    ...(statementIndex !== undefined ? { statementIndex } : {}),
  });

const sessionFromClient = (client: Pick<PoolClient, "query">): LegacyDbSession => ({
  restoreRoleSql: "SET SESSION ROLE postgres",
  restoreSearchPathSql: PLATFORM_SEARCH_PATH_SQL,
  exec: (sql) =>
    Effect.tryPromise({
      try: async () => {
        await client.query(sql);
      },
      catch: (cause) => toExecError(cause),
    }),
  execBatch: (statements) =>
    Effect.gen(function* () {
      const run = (sql: string, params?: ReadonlyArray<unknown>, statementIndex?: number) =>
        Effect.tryPromise({
          try: async () => {
            if (params === undefined) {
              await client.query(sql);
              return;
            }
            await client.query(sql, [...params]);
          },
          catch: (cause) => toExecError(cause, statementIndex),
        });
      yield* run("BEGIN");
      yield* Effect.gen(function* () {
        for (const [index, statement] of statements.entries()) {
          yield* run(statement.sql, statement.params, index);
        }
        yield* run("COMMIT");
      }).pipe(Effect.tapError(() => run("ROLLBACK").pipe(Effect.ignore)));
    }),
  query: (sql, params) =>
    Effect.tryPromise({
      try: async () => {
        const result =
          params === undefined
            ? await client.query<Record<string, unknown>>(sql)
            : await client.query<Record<string, unknown>>(sql, [...params]);
        return result.rows;
      },
      catch: (cause) => toExecError(cause),
    }),
  extensionExists: () => Effect.die("legacy migration runner does not query extensions"),
  copyToCsv: () => Effect.die("legacy migration runner does not copy CSV"),
  queryRaw: () => Effect.die("legacy migration runner does not query raw rows"),
});

const withSession = <A, E, R = never>(
  pool: Pool,
  body: (session: LegacyDbSession) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SchemaEngineError | SchemaMigrationsPrivilegeError, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => pool.connect(),
          catch: (cause) => toRunnerErrorFromCause(cause),
        }),
        (held) => Effect.sync(() => held.release()),
      );
      return yield* body(sessionFromClient(client));
    }),
  );

const LIST_HISTORY =
  "SELECT version, coalesce(name, '') AS name FROM supabase_migrations.schema_migrations ORDER BY version";
const LIST_HISTORY_VERSION_ONLY =
  "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";
const LIST_HISTORY_STATEMENTS =
  "SELECT version, coalesce(name, '') AS name, statements FROM supabase_migrations.schema_migrations ORDER BY version";

const toStatements = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.map((entry) => String(entry)) : [];

const isMissingMigrationHistory = (error: LegacyDbExecError): boolean => {
  if (error.code === "3F000" || error.code === "42P01") return true;
  return (
    /relation .* does not exist/iu.test(error.message) &&
    !/column .* does not exist/iu.test(error.message)
  );
};

const isMissingNameColumn = (error: LegacyDbExecError): boolean =>
  /column ["']?name["']? does not exist/iu.test(error.message);

const isMissingStatementsColumn = (error: LegacyDbExecError): boolean =>
  /column ["']?statements["']? does not exist/iu.test(error.message);

const listHistory = (
  session: LegacyDbSession,
): Effect.Effect<
  ReadonlyArray<MigrationHistoryRow>,
  SchemaEngineError | SchemaMigrationsPrivilegeError
> =>
  session.query(LIST_HISTORY).pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        version: String(row["version"] ?? ""),
        name: String(row["name"] ?? ""),
      })),
    ),
    Effect.catch((error: LegacyDbExecError) => {
      if (isMissingMigrationHistory(error)) return Effect.succeed([]);
      if (isMissingNameColumn(error)) {
        return session
          .query(LIST_HISTORY_VERSION_ONLY)
          .pipe(
            Effect.map((rows) =>
              rows.map((row) => ({ version: String(row["version"] ?? ""), name: "" })),
            ),
          );
      }
      return Effect.fail(error);
    }),
    Effect.mapError(mapConnectError),
  );

const listHistoryStatements = (
  session: LegacyDbSession,
): Effect.Effect<
  ReadonlyArray<MigrationHistoryStatementsRow>,
  SchemaEngineError | SchemaMigrationsPrivilegeError
> =>
  session.query(LIST_HISTORY_STATEMENTS).pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        version: String(row["version"] ?? ""),
        name: String(row["name"] ?? ""),
        statements: toStatements(row["statements"]),
      })),
    ),
    Effect.catch((error: LegacyDbExecError) => {
      if (isMissingMigrationHistory(error)) return Effect.succeed([]);
      if (isMissingStatementsColumn(error) || isMissingNameColumn(error)) {
        return session.query(LIST_HISTORY).pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              version: String(row["version"] ?? ""),
              name: String(row["name"] ?? ""),
              statements: [],
            })),
          ),
          Effect.catch((inner: LegacyDbExecError) => {
            if (isMissingMigrationHistory(inner)) return Effect.succeed([]);
            if (isMissingNameColumn(inner)) {
              return session.query(LIST_HISTORY_VERSION_ONLY).pipe(
                Effect.map((rows) =>
                  rows.map((row) => ({
                    version: String(row["version"] ?? ""),
                    name: "",
                    statements: [],
                  })),
                ),
              );
            }
            return Effect.fail(inner);
          }),
        );
      }
      return Effect.fail(error);
    }),
    Effect.mapError(mapConnectError),
  );

export const legacyMigrationRunnerLayer = Layer.effect(
  MigrationRunner,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const listRemote = (pool: Pool) => withSession(pool, listHistory);
    const listRemoteStatements = (pool: Pool) => withSession(pool, listHistoryStatements);
    const showServerVersion = (pool: Pool) =>
      withSession(pool, (session) =>
        session.query("SHOW server_version").pipe(
          Effect.map((rows) => {
            const raw = rows[0]?.["server_version"];
            return typeof raw === "string" && raw.length > 0 ? raw : undefined;
          }),
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      ).pipe(Effect.catch(() => Effect.succeed(undefined)));
    const listInstalledExtensions = (pool: Pool) =>
      withSession(pool, (session) =>
        session.query("SELECT extname FROM pg_extension").pipe(
          Effect.map((rows) =>
            rows
              .map((row) => String(row["extname"] ?? "").toLowerCase())
              .filter((name) => name.length > 0),
          ),
          Effect.mapError(mapConnectError),
        ),
      );

    return MigrationRunner.of({
      listRemote,
      listRemoteStatements,
      showServerVersion,
      listInstalledExtensions,
      applyPending: (pool, local) =>
        withSession(pool, (session) =>
          Effect.gen(function* () {
            const remote = yield* listHistory(session);
            const remoteVersions = new Set(remote.map((row) => row.version));
            const pendingFiles = local.filter((file) => !remoteVersions.has(file.version));
            const remoteOnly = remote
              .filter((row) => !local.some((file) => file.version === row.version))
              .map((row) => row.version);
            if (remoteOnly.length > 0 && pendingFiles.length > 0) {
              return yield* new SchemaHistoryConflictError(
                formatHistoryConflict({
                  remoteOnly,
                  pending: pendingFiles.map((file) => file.version),
                }),
              );
            }
            const output = yield* Output;
            yield* legacyApplyMigrations(
              session,
              fs,
              path,
              pendingFiles.map((file) => file.absolutePath),
              (message) =>
                engineError(
                  message.startsWith("Failed applying")
                    ? message
                    : `Failed applying migration: ${message}`,
                ),
            ).pipe(Effect.provideService(Output, output), Effect.mapError(mapConnectError));
            return {
              applied: pendingFiles.map((file) => file.version),
              skipped: local
                .filter((file) => remoteVersions.has(file.version))
                .map((file) => file.version),
            } satisfies MigrationApplyResult;
          }),
        ),
      markApplied: (pool, files) =>
        withSession(pool, (session) =>
          Effect.gen(function* () {
            yield* legacyCreateMigrationTable(session).pipe(Effect.mapError(mapConnectError));
            const remote = yield* legacyListRemoteMigrations(session).pipe(
              Effect.mapError(mapConnectError),
            );
            const present = new Set(remote);
            for (const file of files) {
              if (present.has(file.version)) continue;
              yield* session
                .query(INSERT_MIGRATION_VERSION, [file.version, file.name, [file.content]])
                .pipe(Effect.mapError(mapConnectError));
            }
          }),
        ),
    });
  }),
);
