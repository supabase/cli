import { Effect, type FileSystem, Option, type Path } from "effect";

import { listLocalMigrations } from "./migration-list.ts";
import { bold } from "./colors.ts";
import { compareUtf8Bytes } from "./glob.ts";
import type { DbExecError } from "./db-connection.errors.ts";
import type { DbSession } from "./db-connection.service.ts";
import {
  MIGRATION_VERSION_MAX,
  compareMigrationVersions,
  parseMigrationVersion,
  sortMigrationVersions,
} from "./migration-timestamp.format.ts";
import { MigrationsReadError } from "./migration.errors.ts";
import { parseMigrationContent } from "./migration-file.ts";

/**
 * Consolidated `supabase_migrations.schema_migrations` history module — the single home for
 * the migration-history DDL/DML and the read/reconcile helpers shared by `db diff/pull`,
 * `migration *`, and the declarative generate/sync handlers.
 */

// `SET LOCAL` (not bare `SET`) scopes the timeout to the wrapping transaction, so it reverts on
// `COMMIT` instead of leaking the 4s timeout into a caller's real work (e.g. `migration repair`'s
// TRUNCATE/UPSERT or seed SQL).
const SET_LOCAL_LOCK_TIMEOUT = "SET LOCAL lock_timeout = '4s'";
const CREATE_VERSION_SCHEMA = "CREATE SCHEMA IF NOT EXISTS supabase_migrations";
const CREATE_VERSION_TABLE =
  "CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY)";
const ADD_STATEMENTS_COLUMN =
  "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[]";
const ADD_NAME_COLUMN =
  "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text";

export const INSERT_MIGRATION_VERSION =
  "INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)";

/** Used by `migration repair` to record an already-applied migration. */
export const UPSERT_MIGRATION_VERSION =
  "INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3) ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name, statements = EXCLUDED.statements";

/** Used by `migration repair --status reverted`. */
export const DELETE_MIGRATION_VERSION =
  "DELETE FROM supabase_migrations.schema_migrations WHERE version = ANY($1)";

/** Drops history at or before a `migration squash` baseline version. */
export const DELETE_MIGRATION_BEFORE =
  "DELETE FROM supabase_migrations.schema_migrations WHERE version <= $1";

/** Used by `migration repair` to reset the whole history table. */
export const TRUNCATE_VERSION_TABLE = "TRUNCATE supabase_migrations.schema_migrations";

const LIST_MIGRATION_VERSION =
  "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";

/** Full history rows for `migration fetch`. */
const SELECT_VERSION_TABLE =
  "SELECT version, coalesce(name, '') as name, statements FROM supabase_migrations.schema_migrations";

const CREATE_SEED_TABLE =
  "CREATE TABLE IF NOT EXISTS supabase_migrations.seed_files (path text NOT NULL PRIMARY KEY, hash text NOT NULL)";
export const UPSERT_SEED_FILE =
  "INSERT INTO supabase_migrations.seed_files(path, hash) VALUES($1, $2) ON CONFLICT (path) DO UPDATE SET hash = EXCLUDED.hash";
const SELECT_SEED_TABLE = "SELECT path, hash FROM supabase_migrations.seed_files";

/** Matches `<digits>_<name>.sql`. */
export const MIGRATE_FILE_PATTERN = /^([0-9]+)_(.*)\.sql$/u;

/**
 * Read-only probe: `true` when the relation is an ordinary or partitioned table carrying every
 * live column its DDL creates, i.e. when each setup statement below is a guaranteed no-op. Sent
 * with no bind parameters, matching the wire shape of the `migration list` SELECT that
 * demonstrably survives poolers this setup DDL dies on. Any unexpected answer falls through to
 * the DDL path, but a probe failure aborts instead: a connection that cannot serve this SELECT
 * will not serve the setup transaction either, and failing loudly surfaces the real error rather
 * than masking it behind a DDL failure. Interpolates its arguments verbatim: callers pass
 * compile-time literals only.
 */
const provisionedProbe = (relation: string, columns: ReadonlyArray<string>) =>
  `SELECT count(*) = ${columns.length} AS provisioned FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid WHERE a.attrelid = pg_catalog.to_regclass('${relation}') AND c.relkind IN ('r', 'p') AND NOT a.attisdropped AND a.attname IN (${columns.map((column) => `'${column}'`).join(", ")})`;

const SELECT_VERSION_TABLE_PROVISIONED = provisionedProbe("supabase_migrations.schema_migrations", [
  "version",
  "name",
  "statements",
]);
const SELECT_SEED_TABLE_PROVISIONED = provisionedProbe("supabase_migrations.seed_files", [
  "path",
  "hash",
]);

const isTableProvisioned = (session: DbSession, probe: string) =>
  session.query(probe).pipe(Effect.map((rows) => rows[0]?.["provisioned"] === true));

/**
 * Creates the migration-history schema/table (idempotent). Skipped entirely when the
 * provisioning probe finds the ledger already current; an older or partial ledger still gets the
 * full setup, in one transaction so `SET LOCAL lock_timeout` reverts on `COMMIT` and never leaks
 * into the caller's subsequent work. A failed statement rolls back.
 */
export const createMigrationTable = (session: DbSession) =>
  Effect.flatMap(isTableProvisioned(session, SELECT_VERSION_TABLE_PROVISIONED), (provisioned) =>
    provisioned
      ? Effect.void
      : Effect.gen(function* () {
          yield* session.exec("BEGIN");
          yield* session.exec(SET_LOCAL_LOCK_TIMEOUT);
          yield* session.exec(CREATE_VERSION_SCHEMA);
          yield* session.exec(CREATE_VERSION_TABLE);
          yield* session.exec(ADD_STATEMENTS_COLUMN);
          yield* session.exec(ADD_NAME_COLUMN);
          yield* session.exec("COMMIT");
        }).pipe(Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore))),
  );

/**
 * Creates the `seed_files` schema/table (idempotent). Probed and skipped when already
 * provisioned; otherwise the same transaction-scoped `SET LOCAL lock_timeout` as
 * `createMigrationTable`, so the timeout reverts on `COMMIT` and never leaks into the seed SQL
 * the caller runs next.
 */
export const createSeedTable = (session: DbSession) =>
  Effect.flatMap(isTableProvisioned(session, SELECT_SEED_TABLE_PROVISIONED), (provisioned) =>
    provisioned
      ? Effect.void
      : Effect.gen(function* () {
          yield* session.exec("BEGIN");
          yield* session.exec(SET_LOCAL_LOCK_TIMEOUT);
          yield* session.exec(CREATE_VERSION_SCHEMA);
          yield* session.exec(CREATE_SEED_TABLE);
          yield* session.exec("COMMIT");
        }).pipe(Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore))),
  );

/** A recorded seed file's path + content hash. */
export interface SeedRow {
  readonly path: string;
  readonly hash: string;
}

/**
 * Reads `supabase_migrations.seed_files` (path → hash). A missing table (42P01) means no seeds
 * applied yet, so this returns empty rather than failing.
 */
export const readSeedTable = (session: DbSession) =>
  session.query(SELECT_SEED_TABLE).pipe(
    Effect.map((rows) =>
      rows.map<SeedRow>((row) => ({
        path: String(row["path"] ?? ""),
        hash: String(row["hash"] ?? ""),
      })),
    ),
    Effect.catch((error) =>
      isUndefinedTableError(error)
        ? Effect.succeed<ReadonlyArray<SeedRow>>([])
        : Effect.fail(new MigrationsReadError({ message: error.message })),
    ),
  );

/** The outcome of comparing remote vs local migration histories. */
export type MigrationSync =
  | { readonly kind: "in-sync" }
  | { readonly kind: "missing" }
  | { readonly kind: "conflict"; readonly suggestion: string };

/**
 * Reconciles the remote and local migration version lists via a two-pointer comparison:
 * versions that fail to parse as integers are skipped; any extra remote/local version is a
 * conflict; an empty local set is `missing`; otherwise in-sync.
 */
export function reconcileMigrations(
  remote: ReadonlyArray<string>,
  local: ReadonlyArray<string>,
  isLocal = false,
): MigrationSync {
  // `MIGRATION_VERSION_MAX` pins the exhausted side of the walk; `parseMigrationVersion` is
  // shared with `migration list` so both surfaces skip the same edge-case versions.
  // `loadLocalVersions` yields versions in file-name order, which reverses `ORDER BY version`
  // whenever one version is a prefix of another — the same desynchronisation
  // `findPendingMigrations` sorts away below.
  const sortedLocal = sortMigrationVersions(local);
  const extraRemote: Array<string> = [];
  const extraLocal: Array<string> = [];
  let i = 0;
  let j = 0;
  while (i < remote.length || j < sortedLocal.length) {
    let remoteTs = MIGRATION_VERSION_MAX;
    if (i < remote.length) {
      const parsed = parseMigrationVersion(remote[i]!);
      if (parsed === undefined) {
        i++;
        continue;
      }
      remoteTs = parsed;
    }
    let localTs = MIGRATION_VERSION_MAX;
    if (j < sortedLocal.length) {
      const parsed = parseMigrationVersion(sortedLocal[j]!);
      if (parsed === undefined) {
        j++;
        continue;
      }
      localTs = parsed;
    }
    if (localTs < remoteTs) {
      extraLocal.push(sortedLocal[j]!);
      j++;
    } else if (remoteTs < localTs) {
      extraRemote.push(remote[i]!);
      i++;
    } else {
      i++;
      j++;
    }
  }
  if (extraRemote.length + extraLocal.length > 0) {
    return {
      kind: "conflict",
      suggestion: suggestMigrationRepair(extraRemote, extraLocal, isLocal),
    };
  }
  if (local.length === 0) {
    return { kind: "missing" };
  }
  return { kind: "in-sync" };
}

export function suggestMigrationRepair(
  extraRemote: ReadonlyArray<string>,
  extraLocal: ReadonlyArray<string>,
  isLocal = false,
): string {
  const localFlag = isLocal ? " --local" : "";
  let result =
    "\nMake sure your local git repo is up-to-date. If the error persists, try repairing the migration history table:\n";
  for (const version of extraRemote) {
    result += `${bold(`supabase migration repair${localFlag} --status reverted ${version}`)}\n`;
  }
  for (const version of extraLocal) {
    result += `${bold(`supabase migration repair${localFlag} --status applied ${version}`)}\n`;
  }
  return result;
}

/** Each generated line ends with a trailing newline, including the last one. */
export function suggestRevertHistory(versions: ReadonlyArray<string>, isLocal = false): string {
  const localFlag = isLocal ? " --local" : "";
  return (
    "\nMake sure your local git repo is up-to-date. If the error persists, try repairing the migration history table:\n" +
    `${bold(`supabase migration repair${localFlag} --status reverted ${versions.join(" ")}`)}\n` +
    "\nAnd update local migrations to match remote database:\n" +
    `${bold(`supabase db pull${localFlag}`)}\n`
  );
}

/**
 * Lists the remote project's applied migration versions. Only a missing history table (SQLSTATE
 * 42P01) means the remote has no migrations and returns `[]`; any other error (e.g. a malformed
 * table missing the `version` column, 42703) propagates rather than being silently treated as an
 * initial pull. If the driver doesn't surface a SQLSTATE, falls back to a message check that
 * matches a missing relation but not a missing column.
 */
export const listRemoteMigrations = (session: DbSession) =>
  session.query(LIST_MIGRATION_VERSION).pipe(
    Effect.map((rows) => rows.map((row) => String(row["version"]))),
    Effect.catch((error) =>
      isUndefinedTableError(error)
        ? Effect.succeed<ReadonlyArray<string>>([])
        : Effect.fail(new MigrationsReadError({ message: error.message })),
    ),
  );

/** Whether a query error is Postgres's `undefined_table` (42P01). */
const isUndefinedTableError = (error: DbExecError): boolean => {
  if (error.code !== undefined) return error.code === "42P01";
  // No SQLSTATE surfaced: a relation-not-exist message counts, a column-not-exist
  // one does not (Postgres phrases an undefined column as `column "x" does not exist`).
  return (
    /relation .* does not exist/iu.test(error.message) &&
    !/column .* does not exist/iu.test(error.message)
  );
};

/**
 * Lists local migration file paths (sorted, init-schema skipped). Thin re-export of
 * `listLocalMigrations` so `migration` handlers reach it through this shared module rather than
 * importing the `db`-command-scoped cache directly; `commands/db/shared` stays the single
 * implementation.
 */
export const listLocalMigrationPaths = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
) => listLocalMigrations(fs, path, migrationsDir);

/** Loads the local migration versions (the `<timestamp>` prefixes). */
export const loadLocalVersions = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
) =>
  listLocalMigrations(fs, path, migrationsDir).pipe(
    Effect.map((paths) =>
      paths.flatMap((p) => {
        const match = MIGRATE_FILE_PATTERN.exec(path.basename(p));
        return match?.[1] !== undefined ? [match[1]] : [];
      }),
    ),
  );

/** Basename of a path, handling both `/` and `\` separators (keeps the helper pure). */
const baseName = (filePath: string): string => filePath.split(/[\\/]/u).pop() ?? filePath;

/**
 * Orders local migration paths by version so they line up with `schema_migrations`
 * (`ORDER BY version`) before a two-pointer walk compares the two lists. File-name order and
 * version order only agree while versions are the same width: `20260420010000_b.sql` sorts
 * before `20260420_a.sql` by name (`'0'` < `'_'`) but after it by version. Stable and keyed on
 * the version alone, so same-width sets keep their original name order.
 */
export function sortMigrationPathsByVersion(
  localPaths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [...localPaths].sort((a, b) => {
    const versionA = MIGRATE_FILE_PATTERN.exec(baseName(a))?.[1] ?? "";
    const versionB = MIGRATE_FILE_PATTERN.exec(baseName(b))?.[1] ?? "";
    return compareMigrationVersions(versionA, versionB);
  });
}

/** Outcome of `findPendingMigrations`. */
export type PendingMigrations =
  | { readonly kind: "pending"; readonly paths: ReadonlyArray<string> }
  // Remote versions absent from the local directory.
  | { readonly kind: "missing-local"; readonly versions: ReadonlyArray<string> }
  // Out-of-order local migrations before the last remote.
  | { readonly kind: "missing-remote"; readonly paths: ReadonlyArray<string> };

/**
 * A two-pointer walk over local paths + remote versions. Returns the pending local paths, or
 * flags a remote version missing from local (`missing-local`) or an out-of-order local migration
 * (`missing-remote`). `localPaths` are full paths whose basenames match `<version>_<name>.sql`;
 * `remoteVersions` are sorted. Both sides must agree on ordering, so `localPaths` is re-sorted by
 * version.
 */
export function findPendingMigrations(
  localPaths: ReadonlyArray<string>,
  remoteVersions: ReadonlyArray<string>,
): PendingMigrations {
  const sortedLocal = sortMigrationPathsByVersion(localPaths);
  const unapplied: Array<string> = [];
  const missing: Array<string> = [];
  let i = 0;
  let j = 0;
  while (i < remoteVersions.length && j < sortedLocal.length) {
    const remote = remoteVersions[i]!;
    // `listLocalMigrations` guarantees the basename matches the pattern.
    const local = MIGRATE_FILE_PATTERN.exec(baseName(sortedLocal[j]!))?.[1] ?? "";
    if (remote === local) {
      i++;
      j++;
    } else if (remote < local) {
      missing.push(remote);
      i++;
    } else {
      // Out-of-order local migration (older than an applied remote one).
      unapplied.push(sortedLocal[j]!);
      j++;
    }
  }
  // Any remote versions past the end of local are also missing.
  if (j === sortedLocal.length) {
    for (let k = i; k < remoteVersions.length; k++) missing.push(remoteVersions[k]!);
  }
  if (missing.length > 0) return { kind: "missing-local", versions: missing };
  if (unapplied.length > 0) return { kind: "missing-remote", paths: unapplied };
  return { kind: "pending", paths: sortedLocal.slice(remoteVersions.length) };
}

/**
 * Loads local migration paths whose version is `<= version` (or all when `version` is empty).
 * Version comparison is lexical, matching zero-padded timestamp ordering.
 */
export const loadPartialMigrations = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
  version: string,
) =>
  listLocalMigrations(fs, path, migrationsDir).pipe(
    Effect.map((paths) =>
      // Sorted by version, not file name, so replaying here applies files in the same order
      // `db push` does remotely.
      sortMigrationPathsByVersion(
        paths.filter((p) => {
          if (version.length === 0) return true;
          const v = MIGRATE_FILE_PATTERN.exec(path.basename(p))?.[1];
          return v !== undefined && v <= version;
        }),
      ),
    ),
  );

/** A migration's version, name, and SQL statements. */
export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}

/** Coerce a Postgres `text[]` column value into a string array. */
const toStatements = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.map((entry) => String(entry)) : [];

/** Reads the full migration-history rows (version, name, statements); used by `migration fetch`. */
export const readMigrationTable = (session: DbSession) =>
  session.query(SELECT_VERSION_TABLE).pipe(
    Effect.map((rows) =>
      rows.map<MigrationFile>((row) => ({
        version: String(row["version"] ?? ""),
        name: String(row["name"] ?? ""),
        statements: toStatements(row["statements"]),
      })),
    ),
    Effect.mapError(
      (error) =>
        new MigrationsReadError({
          message: `failed to read migration table: ${error.message}`,
        }),
    ),
  );

/**
 * Resolves the local migration file for a version by globbing `<version>_*.sql` against the
 * migrations dir. Reads the directory then byte-sorts entries before matching, so ties resolve
 * to the byte-ordered first match, not JS's default UTF-16-code-unit order. Returns `None` when
 * nothing matches — the caller raises the not-found error so the exact message can be assembled.
 * A missing directory is treated as no match.
 */
export const resolveMigrationFile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
  version: string,
): Effect.Effect<Option.Option<string>, MigrationsReadError> =>
  fs.readDirectory(migrationsDir).pipe(
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed<ReadonlyArray<string>>([])
        : Effect.fail(
            new MigrationsReadError({
              message: `failed to glob migration files: ${error.message}`,
            }),
          ),
    ),
    Effect.map((names) => {
      const prefix = `${version}_`;
      const matches = names
        .filter((name) => name.startsWith(prefix) && name.endsWith(".sql"))
        .sort(compareUtf8Bytes);
      return matches.length > 0
        ? Option.some(path.join(migrationsDir, matches[0]!))
        : Option.none<string>();
    }),
  );

/**
 * Reads a migration file into its version/name/statements: splits the SQL with the shared
 * splitter and parses the version + name from the basename.
 */
export const readMigrationFile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationPath: string,
): Effect.Effect<MigrationFile, MigrationsReadError> =>
  fs.readFileString(migrationPath).pipe(
    Effect.mapError(
      (error) =>
        new MigrationsReadError({
          message: `failed to open migration file: ${error.message}`,
        }),
    ),
    Effect.map((content) => {
      const parsed = parseMigrationContent(content);
      const match = MIGRATE_FILE_PATTERN.exec(path.basename(migrationPath));
      return {
        version: match?.[1] ?? "",
        name: match?.[2] ?? "",
        statements: parsed.statements,
      };
    }),
  );
