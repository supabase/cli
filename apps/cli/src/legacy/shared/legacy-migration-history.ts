import { Effect, type FileSystem, Option, type Path } from "effect";

import { legacyListLocalMigrations } from "../commands/db/shared/legacy-pgdelta.cache.ts";
import { legacyBold } from "./legacy-colors.ts";
import type { LegacyDbExecError } from "./legacy-db-connection.errors.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import {
  LEGACY_MIGRATION_VERSION_MAX,
  legacyParseMigrationVersion,
} from "./legacy-migration-timestamp.format.ts";
import { LegacyMigrationsReadError } from "./legacy-migration.errors.ts";
import { legacySplitAndTrim } from "./legacy-sql-split.ts";

/**
 * Consolidated `supabase_migrations.schema_migrations` history module — the
 * single home for the migration-history DDL/DML and the read/reconcile helpers
 * shared by `db diff/pull`, `migration *`, and the declarative generate/sync
 * handlers. SQL is verbatim from Go's `pkg/migration/history.go`; the helpers
 * port `pkg/migration/list.go`, `internal/migration/list/list.go`, and
 * `internal/db/pull/pull.go`.
 */

// Migration-history DDL/DML, verbatim from Go's `pkg/migration/history.go`.
// `SET LOCAL` (not bare `SET`) scopes the timeout to the wrapping transaction so it
// reverts on `COMMIT` — reproducing Go, where `CreateMigrationTable`/`CreateSeedTable`
// run through `pgconn.ExecBatch` (an implicit transaction whose `SET` reverts when the
// batch ends; `history.go:32-33`, `file.go:87`). A bare session-level `SET` would leak
// the 4s timeout into a caller's real work (e.g. `migration repair`'s TRUNCATE/UPSERT
// or seed SQL), which Go never does.
const SET_LOCAL_LOCK_TIMEOUT = "SET LOCAL lock_timeout = '4s'";
const CREATE_VERSION_SCHEMA = "CREATE SCHEMA IF NOT EXISTS supabase_migrations";
const CREATE_VERSION_TABLE =
  "CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY)";
const ADD_STATEMENTS_COLUMN =
  "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[]";
const ADD_NAME_COLUMN =
  "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text";

/** `INSERT(version, name, statements)` — Go's `INSERT_MIGRATION_VERSION`. */
export const INSERT_MIGRATION_VERSION =
  "INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)";

/** Upsert variant used to record an already-applied migration — Go's repair UPSERT. */
export const UPSERT_MIGRATION_VERSION =
  "INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3) ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name, statements = EXCLUDED.statements";

/** `DELETE ... WHERE version = ANY($1)` — Go's `DELETE_MIGRATION_VERSION` (repair reverted). */
export const DELETE_MIGRATION_VERSION =
  "DELETE FROM supabase_migrations.schema_migrations WHERE version = ANY($1)";

/** `TRUNCATE supabase_migrations.schema_migrations` — Go's repair-all reset. */
export const TRUNCATE_VERSION_TABLE = "TRUNCATE supabase_migrations.schema_migrations";

/** `SELECT version FROM supabase_migrations.schema_migrations ORDER BY version`. */
const LIST_MIGRATION_VERSION =
  "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";

/** Go's `SELECT_VERSION_TABLE` — full history rows for `migration fetch`. */
const SELECT_VERSION_TABLE =
  "SELECT version, coalesce(name, '') as name, statements FROM supabase_migrations.schema_migrations";

/** `supabase_migrations.seed_files` DDL/DML — Go's seed-tracking SQL (`history.go`). */
const CREATE_SEED_TABLE =
  "CREATE TABLE IF NOT EXISTS supabase_migrations.seed_files (path text NOT NULL PRIMARY KEY, hash text NOT NULL)";
export const UPSERT_SEED_FILE =
  "INSERT INTO supabase_migrations.seed_files(path, hash) VALUES($1, $2) ON CONFLICT (path) DO UPDATE SET hash = EXCLUDED.hash";
const SELECT_SEED_TABLE = "SELECT path, hash FROM supabase_migrations.seed_files";

/** `pkg/migration/file.go` — `<digits>_<name>.sql`. */
export const MIGRATE_FILE_PATTERN = /^([0-9]+)_(.*)\.sql$/u;

/**
 * Creates the migration-history schema/table (idempotent). Go's `CreateMigrationTable`.
 * The setup runs in one transaction so `SET LOCAL lock_timeout` is scoped to it and
 * reverts on `COMMIT`, matching Go's implicit `pgconn.ExecBatch` transaction; the GUC
 * never leaks into the caller's subsequent work. A failed statement rolls back.
 */
export const legacyCreateMigrationTable = (session: LegacyDbSession) =>
  Effect.gen(function* () {
    yield* session.exec("BEGIN");
    yield* session.exec(SET_LOCAL_LOCK_TIMEOUT);
    yield* session.exec(CREATE_VERSION_SCHEMA);
    yield* session.exec(CREATE_VERSION_TABLE);
    yield* session.exec(ADD_STATEMENTS_COLUMN);
    yield* session.exec(ADD_NAME_COLUMN);
    yield* session.exec("COMMIT");
  }).pipe(Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore)));

/**
 * Creates the `seed_files` schema/table (idempotent). Go's `CreateSeedTable`. Same
 * transaction-scoped `SET LOCAL lock_timeout` as `legacyCreateMigrationTable` so the
 * timeout reverts on `COMMIT` and never leaks into the seed SQL the caller runs next.
 */
export const legacyCreateSeedTable = (session: LegacyDbSession) =>
  Effect.gen(function* () {
    yield* session.exec("BEGIN");
    yield* session.exec(SET_LOCAL_LOCK_TIMEOUT);
    yield* session.exec(CREATE_VERSION_SCHEMA);
    yield* session.exec(CREATE_SEED_TABLE);
    yield* session.exec("COMMIT");
  }).pipe(Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore)));

/** A recorded seed file's path + content hash. Go's `migration.SeedFile`. */
export interface LegacySeedRow {
  readonly path: string;
  readonly hash: string;
}

/**
 * Reads `supabase_migrations.seed_files` (path → hash). Mirrors Go's
 * `getRemoteSeeds` (`pkg/migration/seed.go:17`): a missing table (42P01) means no
 * seeds applied yet → empty.
 */
export const legacyReadSeedTable = (session: LegacyDbSession) =>
  session.query(SELECT_SEED_TABLE).pipe(
    Effect.map((rows) =>
      rows.map<LegacySeedRow>((row) => ({
        path: String(row["path"] ?? ""),
        hash: String(row["hash"] ?? ""),
      })),
    ),
    Effect.catch((error) =>
      legacyIsUndefinedTableError(error)
        ? Effect.succeed<ReadonlyArray<LegacySeedRow>>([])
        : Effect.fail(new LegacyMigrationsReadError({ message: error.message })),
    ),
  );

/** The outcome of comparing remote vs local migration histories. */
export type LegacyMigrationSync =
  | { readonly kind: "in-sync" }
  | { readonly kind: "missing" }
  | { readonly kind: "conflict"; readonly suggestion: string };

/**
 * Reconciles the remote and local migration version lists. Pure port of Go's
 * `assertRemoteInSync` two-pointer comparison (`internal/db/pull/pull.go:212-258`):
 * versions that fail to parse as integers are skipped (Go's `Atoi` error →
 * `continue`); any extra remote/local version is a conflict; an empty local set
 * is `missing`; otherwise in-sync.
 */
export function legacyReconcileMigrations(
  remote: ReadonlyArray<string>,
  local: ReadonlyArray<string>,
): LegacyMigrationSync {
  // `LEGACY_MIGRATION_VERSION_MAX` is Go's `math.MaxInt` (int64 max) and pins the
  // exhausted side; `legacyParseMigrationVersion` mirrors Go's `strconv.Atoi`
  // (digits only, within int64, BigInt for exact ordering) and is shared with
  // `migration list` so both surfaces skip the same edge-case versions.
  const extraRemote: Array<string> = [];
  const extraLocal: Array<string> = [];
  let i = 0;
  let j = 0;
  while (i < remote.length || j < local.length) {
    let remoteTs = LEGACY_MIGRATION_VERSION_MAX;
    if (i < remote.length) {
      const parsed = legacyParseMigrationVersion(remote[i]!);
      if (parsed === undefined) {
        i++;
        continue;
      }
      remoteTs = parsed;
    }
    let localTs = LEGACY_MIGRATION_VERSION_MAX;
    if (j < local.length) {
      const parsed = legacyParseMigrationVersion(local[j]!);
      if (parsed === undefined) {
        j++;
        continue;
      }
      localTs = parsed;
    }
    if (localTs < remoteTs) {
      extraLocal.push(local[j]!);
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
    return { kind: "conflict", suggestion: legacySuggestMigrationRepair(extraRemote, extraLocal) };
  }
  if (local.length === 0) {
    return { kind: "missing" };
  }
  return { kind: "in-sync" };
}

/** Go's `suggestMigrationRepair` (`internal/db/pull/pull.go:280-289`). */
export function legacySuggestMigrationRepair(
  extraRemote: ReadonlyArray<string>,
  extraLocal: ReadonlyArray<string>,
): string {
  let result =
    "\nMake sure your local git repo is up-to-date. If the error persists, try repairing the migration history table:\n";
  for (const version of extraRemote) {
    result += `${legacyBold(`supabase migration repair --status reverted ${version}`)}\n`;
  }
  for (const version of extraLocal) {
    result += `${legacyBold(`supabase migration repair --status applied ${version}`)}\n`;
  }
  return result;
}

/**
 * Lists the remote project's applied migration versions. Mirrors Go's
 * `migration.ListRemoteMigrations` (`pkg/migration/list.go:18-31`): ONLY a missing
 * history table (`pgerrcode.UndefinedTable` = `42P01`) means the remote has no
 * migrations and returns `[]`; any other error (e.g. a malformed table missing the
 * `version` column, `42703`) propagates rather than being silently treated as an
 * initial pull. We match the SQLSTATE like Go; if the driver didn't surface a code,
 * fall back to a message check that matches a missing relation but NOT a missing
 * column.
 */
export const legacyListRemoteMigrations = (session: LegacyDbSession) =>
  session.query(LIST_MIGRATION_VERSION).pipe(
    Effect.map((rows) => rows.map((row) => String(row["version"]))),
    Effect.catch((error) =>
      legacyIsUndefinedTableError(error)
        ? Effect.succeed<ReadonlyArray<string>>([])
        : Effect.fail(new LegacyMigrationsReadError({ message: error.message })),
    ),
  );

/** Whether a query error is Postgres `undefined_table` (42P01), matching Go's `pgerrcode.UndefinedTable`. */
const legacyIsUndefinedTableError = (error: LegacyDbExecError): boolean => {
  if (error.code !== undefined) return error.code === "42P01";
  // No SQLSTATE surfaced: a relation-not-exist message counts, a column-not-exist
  // one does not (Postgres phrases an undefined column as `column "x" does not exist`).
  return (
    /relation .* does not exist/iu.test(error.message) &&
    !/column .* does not exist/iu.test(error.message)
  );
};

/**
 * Lists local migration file paths (sorted, init-schema skipped). Thin re-export
 * of `legacyListLocalMigrations` so `migration` handlers reach it through this
 * shared module rather than importing the `db`-command-scoped cache directly
 * (keeps the command-family boundary; the `commands/db/shared` cache stays the
 * single implementation). Mirrors Go's `migration.ListLocalMigrations`.
 */
export const legacyListLocalMigrationPaths = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
) => legacyListLocalMigrations(fs, path, migrationsDir);

/**
 * Loads the local migration versions (the `<timestamp>` prefixes). Mirrors Go's
 * `LoadLocalVersions` (`internal/migration/list/list.go:72`) → `ListLocalMigrations`
 * with a version-collecting filter.
 */
export const legacyLoadLocalVersions = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
) =>
  legacyListLocalMigrations(fs, path, migrationsDir).pipe(
    Effect.map((paths) =>
      paths.flatMap((p) => {
        const match = MIGRATE_FILE_PATTERN.exec(path.basename(p));
        return match?.[1] !== undefined ? [match[1]] : [];
      }),
    ),
  );

/** Basename of a path, handling both `/` and `\` separators (keeps the helper pure). */
const baseName = (filePath: string): string => filePath.split(/[\\/]/u).pop() ?? filePath;

/** Outcome of `legacyFindPendingMigrations` — Go's `(slice, error)` as a tagged union. */
export type LegacyPendingMigrations =
  | { readonly kind: "pending"; readonly paths: ReadonlyArray<string> }
  // Go's `ErrMissingLocal`: remote versions absent from the local directory.
  | { readonly kind: "missing-local"; readonly versions: ReadonlyArray<string> }
  // Go's `ErrMissingRemote`: out-of-order local migrations before the last remote.
  | { readonly kind: "missing-remote"; readonly paths: ReadonlyArray<string> };

/**
 * Pure port of Go's `FindPendingMigrations` (`pkg/migration/apply.go:21`): a
 * two-pointer walk over local paths + remote versions. Returns the pending local
 * paths, or flags a remote version missing from local (`missing-local`) or an
 * out-of-order local migration (`missing-remote`). `localPaths` are full paths
 * whose basenames match `<version>_<name>.sql`; `remoteVersions` are sorted.
 */
export function legacyFindPendingMigrations(
  localPaths: ReadonlyArray<string>,
  remoteVersions: ReadonlyArray<string>,
): LegacyPendingMigrations {
  const unapplied: Array<string> = [];
  const missing: Array<string> = [];
  let i = 0;
  let j = 0;
  while (i < remoteVersions.length && j < localPaths.length) {
    const remote = remoteVersions[i]!;
    // `legacyListLocalMigrations` guarantees the basename matches the pattern.
    const local = MIGRATE_FILE_PATTERN.exec(baseName(localPaths[j]!))?.[1] ?? "";
    if (remote === local) {
      i++;
      j++;
    } else if (remote < local) {
      missing.push(remote);
      i++;
    } else {
      // Out-of-order local migration (older than an applied remote one).
      unapplied.push(localPaths[j]!);
      j++;
    }
  }
  // Any remote versions past the end of local are also missing.
  if (j === localPaths.length) {
    for (let k = i; k < remoteVersions.length; k++) missing.push(remoteVersions[k]!);
  }
  if (missing.length > 0) return { kind: "missing-local", versions: missing };
  if (unapplied.length > 0) return { kind: "missing-remote", paths: unapplied };
  return { kind: "pending", paths: localPaths.slice(remoteVersions.length) };
}

/**
 * Loads local migration paths whose version is `<= version` (or all when
 * `version` is empty). Mirrors Go's `list.LoadPartialMigrations`
 * (`internal/migration/list/list.go:81`); version comparison is lexical, matching
 * Go's `v <= version` on zero-padded timestamps.
 */
export const legacyLoadPartialMigrations = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
  version: string,
) =>
  legacyListLocalMigrations(fs, path, migrationsDir).pipe(
    Effect.map((paths) =>
      paths.filter((p) => {
        if (version.length === 0) return true;
        const v = MIGRATE_FILE_PATTERN.exec(path.basename(p))?.[1];
        return v !== undefined && v <= version;
      }),
    ),
  );

/** A migration's version, name, and SQL statements — Go's `migration.MigrationFile`. */
export interface LegacyMigrationFile {
  readonly version: string;
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}

/** Coerce a Postgres `text[]` column value into a string array. */
const toStatements = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.map((entry) => String(entry)) : [];

/**
 * Reads the full migration-history rows (version, name, statements). Mirrors Go's
 * `ReadMigrationTable` (`pkg/migration/history.go:46`) — used by `migration fetch`.
 */
export const legacyReadMigrationTable = (session: LegacyDbSession) =>
  session.query(SELECT_VERSION_TABLE).pipe(
    Effect.map((rows) =>
      rows.map<LegacyMigrationFile>((row) => ({
        version: String(row["version"] ?? ""),
        name: String(row["name"] ?? ""),
        statements: toStatements(row["statements"]),
      })),
    ),
    Effect.mapError(
      (error) =>
        new LegacyMigrationsReadError({
          message: `failed to read migration table: ${error.message}`,
        }),
    ),
  );

/**
 * Resolves the local migration file for a version by globbing `<version>_*.sql`
 * against the migrations dir. Mirrors Go's `repair.GetMigrationFile`
 * (`internal/migration/repair/repair.go:90`): the lexically-first match, or
 * `None` when nothing matches (the caller raises the not-found error so the
 * exact Go message can be assembled). A missing directory is treated as no match.
 */
export const legacyResolveMigrationFile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
  version: string,
): Effect.Effect<Option.Option<string>, LegacyMigrationsReadError> =>
  fs.readDirectory(migrationsDir).pipe(
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed<ReadonlyArray<string>>([])
        : Effect.fail(
            new LegacyMigrationsReadError({
              message: `failed to glob migration files: ${error.message}`,
            }),
          ),
    ),
    Effect.map((names) => {
      const prefix = `${version}_`;
      const matches = names
        .filter((name) => name.startsWith(prefix) && name.endsWith(".sql"))
        .sort();
      return matches.length > 0
        ? Option.some(path.join(migrationsDir, matches[0]!))
        : Option.none<string>();
    }),
  );

/**
 * Reads a migration file into its version/name/statements. Mirrors Go's
 * `NewMigrationFromFile` (`pkg/migration/file.go:36`): split the SQL with the
 * shared splitter and parse the version + name from the basename.
 */
export const legacyReadMigrationFile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationPath: string,
): Effect.Effect<LegacyMigrationFile, LegacyMigrationsReadError> =>
  fs.readFileString(migrationPath).pipe(
    Effect.mapError(
      (error) =>
        new LegacyMigrationsReadError({
          message: `failed to open migration file: ${error.message}`,
        }),
    ),
    Effect.map((content) => {
      const match = MIGRATE_FILE_PATTERN.exec(path.basename(migrationPath));
      return {
        version: match?.[1] ?? "",
        name: match?.[2] ?? "",
        statements: legacySplitAndTrim(content),
      };
    }),
  );
