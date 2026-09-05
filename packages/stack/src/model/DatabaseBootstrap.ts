import { Data, Effect, Redacted } from "effect";

/** A small runtime-neutral SQL boundary used by the internal database bootstrap. */
export type DatabaseSqlValue = string | number | boolean | null;

/** Login roles provisioned by the managed database template. */
const DATABASE_BOOTSTRAP_ROLES = [
  "postgres",
  "authenticator",
  "pgbouncer",
  "supabase_auth_admin",
  "supabase_storage_admin",
  "supabase_replication_admin",
  "supabase_read_only_user",
] as const;
type DatabaseBootstrapRole = (typeof DATABASE_BOOTSTRAP_ROLES)[number];

export type DatabaseBootstrapSetting =
  | {
      readonly name: "app.settings.jwt_secret";
      readonly value: Redacted.Redacted<string>;
    }
  | {
      readonly name: "app.settings.jwt_exp";
      readonly value: number;
    };

export interface DatabaseBootstrapOptions {
  /** One managed password shared by the closed login roles. */
  readonly databasePassword: Redacted.Redacted<string>;
  /** Managed JWT material applied to the database settings on each invocation. */
  readonly jwtSecret: Redacted.Redacted<string>;
  readonly jwtExpiry: number;
}

export class DatabaseBootstrapError extends Data.TaggedError("DatabaseBootstrapError")<{
  readonly message: string;
  readonly statement?: string;
  /** Whether retrying the database operation may succeed once the server settles. */
  readonly retryable?: boolean;
  readonly cause?: unknown;
}> {}

/**
 * The bootstrap intentionally knows nothing about a PostgreSQL client. A
 * native or container runtime supplies this boundary from its already-ready
 * database connection.
 */
export interface DatabaseTransaction {
  readonly execute: (
    statement: string,
    parameters?: ReadonlyArray<DatabaseSqlValue>,
  ) => Effect.Effect<void, DatabaseBootstrapError>;
  readonly setRolePassword: (
    role: DatabaseBootstrapRole,
    password: Redacted.Redacted<string>,
  ) => Effect.Effect<void, DatabaseBootstrapError>;
  readonly setDatabaseSetting: (
    setting: DatabaseBootstrapSetting,
  ) => Effect.Effect<void, DatabaseBootstrapError>;
}

export interface DatabaseSession {
  readonly execute: (
    statement: string,
    parameters?: ReadonlyArray<DatabaseSqlValue>,
  ) => Effect.Effect<void, DatabaseBootstrapError>;
  /** Applies all operations in the callback and commits them atomically. */
  readonly transaction: (
    use: (transaction: DatabaseTransaction) => Effect.Effect<void, DatabaseBootstrapError>,
  ) => Effect.Effect<void, DatabaseBootstrapError>;
}

const REALTIME_SCHEMA_STATEMENT =
  "CREATE SCHEMA IF NOT EXISTS _realtime;\nALTER SCHEMA _realtime OWNER TO postgres;";
const ADVISORY_LOCK_STATEMENT = `SELECT pg_advisory_xact_lock(hashtext('supabase_internal.bootstrap'));`;

const statementError = (error: DatabaseBootstrapError, statement: string) =>
  new DatabaseBootstrapError({
    message: error.message,
    statement,
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  });

/** Reconciles the runtime-owned schema, roles, and settings in one transaction. */
export const runDatabaseBootstrap = (
  session: DatabaseSession,
  options: DatabaseBootstrapOptions,
): Effect.Effect<void, DatabaseBootstrapError> =>
  session.transaction((transaction) =>
    Effect.gen(function* () {
      yield* transaction
        .execute(ADVISORY_LOCK_STATEMENT)
        .pipe(Effect.mapError((error) => statementError(error, ADVISORY_LOCK_STATEMENT)));
      yield* transaction
        .execute(REALTIME_SCHEMA_STATEMENT)
        .pipe(Effect.mapError((error) => statementError(error, REALTIME_SCHEMA_STATEMENT)));
      for (const role of DATABASE_BOOTSTRAP_ROLES) {
        yield* transaction.setRolePassword(role, options.databasePassword).pipe(
          Effect.mapError(
            (error) =>
              new DatabaseBootstrapError({
                message: `Unable to configure internal database role ${role}`,
                ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
              }),
          ),
        );
      }
      yield* transaction
        .setDatabaseSetting({
          name: "app.settings.jwt_secret",
          value: options.jwtSecret,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new DatabaseBootstrapError({
                message: "Unable to configure database JWT secret",
                ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
              }),
          ),
        );
      yield* transaction
        .setDatabaseSetting({
          name: "app.settings.jwt_exp",
          value: options.jwtExpiry,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new DatabaseBootstrapError({
                message: "Unable to configure database JWT expiry",
                ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
              }),
          ),
        );
    }),
  );
