import { Effect, type FileSystem, type Path } from "effect";

import { legacyBold } from "../../../shared/legacy-colors.ts";
import type { LegacyDbSession } from "../../../shared/legacy-db-connection.service.ts";
import { legacySplitAndTrim } from "../../../shared/legacy-sql-split.ts";
import { LegacyMigrationsReadError } from "../shared/legacy-pgdelta.errors.ts";
import { legacyListLocalMigrations } from "../shared/legacy-pgdelta.cache.ts";
import { LegacyDbPullWriteError } from "./pull.errors.ts";

/** `SELECT version FROM supabase_migrations.schema_migrations ORDER BY version`. */
const LIST_MIGRATION_VERSION =
  "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";

// Migration-history DDL/DML, verbatim from Go's `pkg/migration/history.go`.
const SET_LOCK_TIMEOUT = "SET lock_timeout = '4s'";
const CREATE_VERSION_SCHEMA = "CREATE SCHEMA IF NOT EXISTS supabase_migrations";
const CREATE_VERSION_TABLE =
  "CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY)";
const ADD_STATEMENTS_COLUMN =
  "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[]";
const ADD_NAME_COLUMN =
  "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text";
const UPSERT_MIGRATION_VERSION =
  "INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3) ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name, statements = EXCLUDED.statements";

// `pkg/migration/file.go` — `<digits>_<name>.sql`.
const MIGRATE_FILE_PATTERN = /^([0-9]+)_(.*)\.sql$/u;

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
  const MAX = Number.MAX_SAFE_INTEGER;
  const extraRemote: Array<string> = [];
  const extraLocal: Array<string> = [];
  let i = 0;
  let j = 0;
  // Matches Go's `strconv.Atoi`: digits only, no empty/whitespace/sign/float. A
  // non-parseable version is skipped (Go's `Atoi` error → `continue`).
  const parseVersion = (v: string): number | undefined =>
    /^\d+$/u.test(v) ? Number(v) : undefined;
  while (i < remote.length || j < local.length) {
    let remoteTs = MAX;
    if (i < remote.length) {
      const parsed = parseVersion(remote[i]!);
      if (parsed === undefined) {
        i++;
        continue;
      }
      remoteTs = parsed;
    }
    let localTs = MAX;
    if (j < local.length) {
      const parsed = parseVersion(local[j]!);
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
 * `migration.ListRemoteMigrations` (`pkg/migration/list.go:18`): an undefined
 * history table means the remote has no migrations, so it returns `[]` rather
 * than failing.
 */
export const legacyListRemoteMigrations = (session: LegacyDbSession) =>
  session.query(LIST_MIGRATION_VERSION).pipe(
    Effect.map((rows) => rows.map((row) => String(row["version"]))),
    Effect.catch((error) =>
      /does not exist/iu.test(error.message)
        ? Effect.succeed<ReadonlyArray<string>>([])
        : Effect.fail(new LegacyMigrationsReadError({ message: error.message })),
    ),
  );

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

/**
 * Records the pulled migration as applied in `supabase_migrations.schema_migrations`
 * WITHOUT re-executing it (the schema already exists on the remote). Mirrors Go's
 * `repair.UpdateMigrationTable(conn, [version], Applied, false, fsys)`
 * (`internal/migration/repair/repair.go:58`): create the history table, then UPSERT
 * the version row with the migration's name + statements.
 */
export const legacyUpdateMigrationHistory = (
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationPath: string,
) =>
  Effect.gen(function* () {
    const content = yield* fs.readFileString(migrationPath);
    const statements = legacySplitAndTrim(content);
    const match = MIGRATE_FILE_PATTERN.exec(path.basename(migrationPath));
    const version = match?.[1] ?? "";
    const name = match?.[2] ?? "";
    yield* session.exec(SET_LOCK_TIMEOUT);
    yield* session.exec(CREATE_VERSION_SCHEMA);
    yield* session.exec(CREATE_VERSION_TABLE);
    yield* session.exec(ADD_STATEMENTS_COLUMN);
    yield* session.exec(ADD_NAME_COLUMN);
    yield* session.query(UPSERT_MIGRATION_VERSION, [version, name, statements]);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new LegacyDbPullWriteError({
          message: `failed to update migration table: ${cause.message}`,
        }),
    ),
  );
