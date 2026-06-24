import { Effect, type FileSystem, type Path } from "effect";

import { legacyBold, legacyYellow } from "../../../shared/legacy-colors.ts";
import { legacyListLocalMigrations } from "./legacy-pgdelta.cache.ts";

/**
 * Diagnostic artifacts collected when a pg-delta operation fails (or an empty
 * diff under `PGDELTA_DEBUG`). Mirrors Go's `DebugBundle`
 * (`apps/cli-go/internal/db/declarative/debug.go`). Shared by the declarative
 * commands (ref-based catalogs) and the migration-style `db pull` empty-diff
 * debug bundle (inline catalog strings + connection metadata).
 */
export interface LegacyDebugBundle {
  /** Timestamp-based id (e.g. `20240414-044403`); names the debug subdirectory. */
  readonly id: string;
  readonly sourceRef?: string;
  readonly targetRef?: string;
  /** Inline source catalog JSON; preferred over `sourceRef` when present (Go's debug.go:45-52). */
  readonly sourceCatalog?: string;
  /** Inline target catalog JSON; preferred over `targetRef` when present (Go's debug.go:54-61). */
  readonly targetCatalog?: string;
  readonly migrationSql?: string;
  readonly pgDeltaStderr?: string;
  /** Redacted connection metadata, written to `connection.txt` (Go's debug.go:76-77). */
  readonly connectionInfo?: string;
  readonly error?: string;
  /** Local migration filenames to copy into the bundle. */
  readonly migrations?: ReadonlyArray<string>;
}

/** Go's debug-bundle id layout `20060102-150405` (UTC). */
export function legacyFormatDebugId(millis: number): string {
  const digits = new Date(millis).toISOString().replace(/\D/gu, "").slice(0, 14);
  return `${digits.slice(0, 8)}-${digits.slice(8)}`;
}

const writeBestEffort = (
  fs: FileSystem.FileSystem,
  filePath: string,
  content: string,
): Effect.Effect<void> => fs.writeFileString(filePath, content).pipe(Effect.ignore);

const copyBestEffort = (fs: FileSystem.FileSystem, from: string, to: string): Effect.Effect<void> =>
  fs.readFileString(from).pipe(
    Effect.flatMap((data) => fs.writeFileString(to, data)),
    Effect.ignore,
  );

/**
 * Writes a debug bundle to `<tempDir>/debug/<id>/` and returns the directory.
 * Mirrors Go's `SaveDebugBundle`: creating the top-level directory is fatal (the
 * effect fails so callers don't claim a bundle was saved), while every individual
 * artifact write and the nested `migrations/` dir are best-effort (a failed copy
 * must not mask the original error).
 */
export const legacySaveDebugBundle = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  tempDir: string,
  migrationsDir: string,
  bundle: LegacyDebugBundle,
) {
  const debugDir = path.join(tempDir, "debug", bundle.id);
  // Go's `SaveDebugBundle` returns an error when the top-level debug directory
  // cannot be created (`apps/cli-go/internal/db/declarative/debug.go:40-42`); only
  // the individual artifact writes (and the nested `migrations/` dir) are
  // best-effort once the directory exists. Propagating this failure lets callers
  // suppress the "Debug information saved" message instead of pointing at a
  // directory that was never created.
  yield* fs.makeDirectory(debugDir, { recursive: true });

  // The catalog refs come back from the Go seam as workdir-relative paths
  // (`supabase/.temp/pgdelta/...`); Go chdir's into the workdir before reading them,
  // so resolve against `workdir` rather than the process cwd (`path.resolve` leaves
  // absolute refs unchanged). An inline catalog string takes precedence over the
  // ref (Go's debug.go:45-61), matching the `db pull` empty-diff path which holds
  // the catalogs in memory rather than as files.
  if (bundle.sourceCatalog !== undefined && bundle.sourceCatalog.length > 0) {
    yield* writeBestEffort(fs, path.join(debugDir, "source-catalog.json"), bundle.sourceCatalog);
  } else if (bundle.sourceRef !== undefined && bundle.sourceRef.length > 0) {
    yield* copyBestEffort(
      fs,
      path.resolve(workdir, bundle.sourceRef),
      path.join(debugDir, "source-catalog.json"),
    );
  }
  if (bundle.targetCatalog !== undefined && bundle.targetCatalog.length > 0) {
    yield* writeBestEffort(fs, path.join(debugDir, "target-catalog.json"), bundle.targetCatalog);
  } else if (bundle.targetRef !== undefined && bundle.targetRef.length > 0) {
    yield* copyBestEffort(
      fs,
      path.resolve(workdir, bundle.targetRef),
      path.join(debugDir, "target-catalog.json"),
    );
  }
  if (bundle.migrationSql !== undefined && bundle.migrationSql.length > 0) {
    yield* writeBestEffort(fs, path.join(debugDir, "generated-migration.sql"), bundle.migrationSql);
  }
  if (bundle.error !== undefined && bundle.error.length > 0) {
    yield* writeBestEffort(fs, path.join(debugDir, "error.txt"), bundle.error);
  }
  if (bundle.pgDeltaStderr !== undefined && bundle.pgDeltaStderr.length > 0) {
    yield* writeBestEffort(fs, path.join(debugDir, "pgdelta-stderr.txt"), bundle.pgDeltaStderr);
  }
  if (bundle.connectionInfo !== undefined && bundle.connectionInfo.length > 0) {
    yield* writeBestEffort(fs, path.join(debugDir, "connection.txt"), bundle.connectionInfo);
  }
  if (bundle.migrations !== undefined && bundle.migrations.length > 0) {
    const migrationsOut = path.join(debugDir, "migrations");
    yield* fs.makeDirectory(migrationsOut, { recursive: true }).pipe(Effect.ignore);
    for (const name of bundle.migrations) {
      yield* copyBestEffort(fs, path.join(migrationsDir, name), path.join(migrationsOut, name));
    }
  }
  return debugDir;
});

/** Collects local migration *filenames* for a debug bundle (Go's `CollectMigrationsList`). */
export const legacyCollectMigrationsList = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
) {
  // Go's `CollectMigrationsList` swallows a `ListLocalMigrations` read error and
  // returns nil (`internal/db/declarative/debug.go:118-128`): the debug bundle is
  // collected while a primary diff/apply error is already in flight, so an
  // unreadable `supabase/migrations` must only omit migration copies, never replace
  // the actionable original error. (The main generate/sync path keeps failing on an
  // unreadable dir — that fail-on-read lives at the direct callers.)
  const migrations = yield* legacyListLocalMigrations(fs, path, migrationsDir).pipe(
    Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
  );
  return migrations.map((p) => path.basename(p));
});

/**
 * Builds the issue-reporting message printed after a debug bundle is saved.
 * Byte-matches Go's `PrintDebugBundleMessage` (leading blank line included).
 */
export function legacyDebugBundleMessage(debugDir: string): string {
  const lines = [""];
  if (debugDir.length > 0) {
    lines.push(`Debug information saved to ${legacyBold(debugDir)}`, "");
  }
  lines.push(
    "To report this issue, you can:",
    "  1. Open an issue at https://github.com/supabase/pg-toolbelt/issues",
    "     Attach the files from the debug folder above.",
    "  2. Open a support ticket at https://supabase.com/dashboard/support",
    "     (only visible to Supabase employees)",
    "",
    legacyYellow("WARNING: The debug folder may contain sensitive information about your"),
    legacyYellow("database schema, including table structures, function definitions, and role"),
    legacyYellow("configurations. Review the contents carefully before sharing publicly."),
    legacyYellow("If unsure, prefer opening a support ticket (option 2) instead."),
  );
  return `${lines.join("\n")}\n`;
}
