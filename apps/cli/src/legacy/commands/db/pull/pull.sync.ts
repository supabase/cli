import { Effect, type FileSystem, type Path } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { legacyBold } from "../../../shared/legacy-colors.ts";
import type { LegacyDbExecError } from "../../../shared/legacy-db-connection.errors.ts";
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
  // Go's `math.MaxInt` on a 64-bit build == math.MaxInt64; the exhausted side pins
  // here. Use BigInt so the full int64 range compares EXACTLY — `Number` loses
  // precision above `Number.MAX_SAFE_INTEGER` (e.g. `Number("9999999999999999")`
  // rounds to 1e16), which would mis-order versions Go accepts.
  const MAX = 9223372036854775807n;
  const extraRemote: Array<string> = [];
  const extraLocal: Array<string> = [];
  let i = 0;
  let j = 0;
  // Matches Go's `strconv.Atoi`: digits only, no empty/whitespace/sign/float. A
  // non-parseable version is skipped (Go's `Atoi` error → `continue`). On 64-bit
  // builds `Atoi` parses the full int64 range and returns a range error ONLY for
  // values above int64 max; reject only those (so e.g. `9999999999999999`, which Go
  // accepts and surfaces as a conflict, is NOT skipped) while still rejecting
  // 19+-digit values above the sentinel so they can never exceed the exhausted-side
  // pin and stall the two-pointer scan.
  const parseVersion = (v: string): bigint | undefined => {
    if (!/^\d+$/u.test(v)) return undefined;
    const parsed = BigInt(v);
    return parsed > MAX ? undefined : parsed;
  };
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
  timestamp: string,
) =>
  Effect.gen(function* () {
    const output = yield* Output;
    const match = MIGRATE_FILE_PATTERN.exec(path.basename(migrationPath));
    if (match === null || match[1] !== timestamp) {
      // Go resolves the repair file by globbing `<timestamp>_*.sql` against the
      // migrations dir and fails with `os.ErrNotExist` when nothing matches
      // (`repair.GetMigrationFile`, `internal/migration/repair/repair.go:90-99`).
      // The glob is anchored on the GENERATED `timestamp` and `*` never crosses a
      // path separator, so a migration name with a separator (`supabase db pull
      // dir/...`) writes a nested file the glob can't reach — even when the nested
      // basename is itself a valid migration filename (`dir/20250101000000_backfill`
      // → basename `20250101000000_backfill.sql`, which DOES match the regex but
      // carries the user's nested timestamp, not the generated one). Require the
      // basename to both match the pattern AND carry the generated timestamp,
      // mirroring Go's anchored glob, rather than trusting `path.basename`.
      return yield* Effect.fail(
        new LegacyDbPullWriteError({
          message: `glob supabase/migrations/${timestamp}_*.sql: file does not exist`,
        }),
      );
    }
    // Guarded above: match[1] === timestamp, so use the generated timestamp
    // directly (avoids re-deriving a `string | undefined` from the regex group).
    const version = timestamp;
    const name = match[2] ?? "";
    yield* Effect.gen(function* () {
      const content = yield* fs.readFileString(migrationPath);
      const statements = legacySplitAndTrim(content);
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
    // Match Go's `repair.UpdateMigrationTable(..., repairAll=false, ...)`, which
    // prints `Repaired migration history: [<version>] => applied` to stderr
    // (`internal/migration/repair/repair.go`). Plain text on stderr, so it does
    // not interfere with machine-output payloads on stdout.
    yield* output.raw(`Repaired migration history: [${version}] => applied\n`, "stderr");
  });
