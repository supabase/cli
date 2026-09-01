import { Data, Effect, Redacted, Schema } from "effect";

/** A small runtime-neutral SQL boundary used by the internal database bootstrap. */
export type DatabaseSqlValue = string | number | boolean | null;

interface DatabaseRow {
  readonly [column: string]: unknown;
}

/** Login roles provisioned by the managed database template. */
type DatabaseBootstrapRole =
  | "postgres"
  | "authenticator"
  | "pgbouncer"
  | "supabase_auth_admin"
  | "supabase_storage_admin"
  | "supabase_replication_admin"
  | "supabase_read_only_user";
const DATABASE_BOOTSTRAP_ROLES: ReadonlyArray<DatabaseBootstrapRole> = [
  "postgres",
  "authenticator",
  "pgbouncer",
  "supabase_auth_admin",
  "supabase_storage_admin",
  "supabase_replication_admin",
  "supabase_read_only_user",
];

export type DatabaseBootstrapSetting =
  | {
      readonly name: "app.settings.jwt_secret";
      readonly value: Redacted.Redacted<string>;
    }
  | {
      readonly name: "app.settings.jwt_exp";
      readonly value: number;
    };

/** Values come from resolved managed secret slots and never become SQL text. */
export interface DatabaseBootstrapCredentials {
  readonly roles?: Readonly<Partial<Record<DatabaseBootstrapRole, Redacted.Redacted<string>>>>;
}

interface DatabaseBootstrapSettings {
  readonly jwtSecret: Redacted.Redacted<string>;
  readonly jwtExpiry: number;
}

export interface DatabaseBootstrapOptions {
  /** Ordered plan resolved for the pinned database release. */
  readonly revisions: ReadonlyArray<DatabaseBootstrapRevision>;
  readonly credentials?: DatabaseBootstrapCredentials;
  /** Configuration values are reconciled on every invocation, like role passwords. */
  readonly settings?: DatabaseBootstrapSettings;
}

export class DatabaseBootstrapError extends Data.TaggedError("DatabaseBootstrapError")<{
  readonly message: string;
  readonly statement?: string;
  readonly revision?: string;
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
  readonly query: (
    statement: string,
    parameters?: ReadonlyArray<DatabaseSqlValue>,
  ) => Effect.Effect<ReadonlyArray<DatabaseRow>, DatabaseBootstrapError>;
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

interface DatabaseBootstrapRevision {
  readonly id: string;
  readonly statement: string;
}

const TRACKING_SCHEMA = "supabase_internal";
const TRACKING_TABLE = `${TRACKING_SCHEMA}.bootstrap_revisions`;

const TRACKING_TABLE_STATEMENT = `
  CREATE SCHEMA IF NOT EXISTS ${TRACKING_SCHEMA};
  CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
    revision text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
`;
const APPLIED_REVISIONS_STATEMENT = `
  SELECT revision FROM ${TRACKING_TABLE} ORDER BY revision;
`;
const RECORD_REVISION_STATEMENT = `
  INSERT INTO ${TRACKING_TABLE} (revision) VALUES ($1)
  ON CONFLICT (revision) DO NOTHING;
`;
const ADVISORY_LOCK_STATEMENT = `SELECT pg_advisory_xact_lock(hashtext('supabase_internal.bootstrap'));`;

const RevisionRowSchema = Schema.Struct({ revision: Schema.String });

const statementError = (error: DatabaseBootstrapError, statement: string, revision?: string) =>
  new DatabaseBootstrapError({
    message: error.message,
    statement,
    ...(revision === undefined ? {} : { revision }),
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  });

/** Runs all unapplied internal revisions, recording each only after it succeeds. */
export const runDatabaseBootstrap = (
  session: DatabaseSession,
  options: DatabaseBootstrapOptions,
): Effect.Effect<void, DatabaseBootstrapError> =>
  Effect.gen(function* () {
    const ids = new Set<string>();
    for (const revision of options.revisions) {
      if (revision.id.trim().length === 0 || ids.has(revision.id))
        return yield* new DatabaseBootstrapError({
          message: "Database bootstrap revision ids must be non-empty and unique",
          revision: revision.id,
        });
      ids.add(revision.id);
    }
    yield* session.transaction((transaction) =>
      Effect.gen(function* () {
        yield* transaction
          .execute(ADVISORY_LOCK_STATEMENT)
          .pipe(Effect.mapError((error) => statementError(error, ADVISORY_LOCK_STATEMENT)));
        yield* transaction
          .execute(TRACKING_TABLE_STATEMENT)
          .pipe(Effect.mapError((error) => statementError(error, TRACKING_TABLE_STATEMENT)));
      }),
    );
    for (const revision of options.revisions) {
      yield* session.transaction((transaction) =>
        Effect.gen(function* () {
          // Re-check under a transaction-scoped advisory lock. This prevents
          // two owners from both applying a non-idempotent revision after
          // observing the same pre-lock snapshot.
          yield* transaction
            .execute(ADVISORY_LOCK_STATEMENT)
            .pipe(Effect.mapError((error) => statementError(error, ADVISORY_LOCK_STATEMENT)));
          const rows = yield* transaction
            .query(APPLIED_REVISIONS_STATEMENT)
            .pipe(Effect.mapError((error) => statementError(error, APPLIED_REVISIONS_STATEMENT)));
          const applied = new Set<string>();
          for (const row of rows) {
            const decoded = yield* Schema.decodeUnknownEffect(RevisionRowSchema)(row).pipe(
              Effect.mapError(
                (cause) =>
                  new DatabaseBootstrapError({
                    message: `Bootstrap tracking row is malformed: ${String(cause)}`,
                    statement: APPLIED_REVISIONS_STATEMENT,
                  }),
              ),
            );
            applied.add(decoded.revision);
          }
          if (applied.has(revision.id)) return;
          yield* transaction
            .execute(revision.statement)
            .pipe(
              Effect.mapError((error) => statementError(error, revision.statement, revision.id)),
            );
          yield* transaction
            .execute(RECORD_REVISION_STATEMENT, [revision.id])
            .pipe(
              Effect.mapError((error) =>
                statementError(error, RECORD_REVISION_STATEMENT, revision.id),
              ),
            );
        }),
      );
    }
    if (options.credentials?.roles !== undefined || options.settings !== undefined) {
      yield* session.transaction((transaction) =>
        Effect.gen(function* () {
          yield* transaction
            .execute(ADVISORY_LOCK_STATEMENT)
            .pipe(Effect.mapError((error) => statementError(error, ADVISORY_LOCK_STATEMENT)));
          if (options.credentials?.roles !== undefined) {
            for (const role of DATABASE_BOOTSTRAP_ROLES) {
              const password = options.credentials.roles[role];
              if (password === undefined) continue;
              yield* transaction.setRolePassword(role, password).pipe(
                Effect.mapError(
                  () =>
                    new DatabaseBootstrapError({
                      message: `Unable to configure internal database role ${role}`,
                    }),
                ),
              );
            }
          }
          if (options.settings !== undefined) {
            yield* transaction
              .setDatabaseSetting({
                name: "app.settings.jwt_secret",
                value: options.settings.jwtSecret,
              })
              .pipe(
                Effect.mapError(
                  () =>
                    new DatabaseBootstrapError({
                      message: "Unable to configure database JWT secret",
                    }),
                ),
              );
            yield* transaction
              .setDatabaseSetting({
                name: "app.settings.jwt_exp",
                value: options.settings.jwtExpiry,
              })
              .pipe(
                Effect.mapError(
                  () =>
                    new DatabaseBootstrapError({
                      message: "Unable to configure database JWT expiry",
                    }),
                ),
              );
          }
        }),
      );
    }
  });
