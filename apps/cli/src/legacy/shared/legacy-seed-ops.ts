import { createHash } from "node:crypto";
import { Effect, type FileSystem, type Path } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import type { LegacyDbExecError } from "./legacy-db-connection.errors.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import { checkScannerBufferSize, legacyWarnResetRoleDrift } from "./legacy-migration-apply.ts";
import { legacyCreateSeedTable } from "./legacy-migration-history.ts";
import { legacySqlFilesGlob } from "./legacy-sql-files-glob.ts";
import { legacySplitAndTrim } from "./legacy-sql-split.ts";

/**
 * Seed-history DML, verbatim from Go's `pkg/migration/history.go`. The schema/table
 * DDL (with a transaction-scoped lock timeout) lives in `legacyCreateSeedTable`.
 */
const UPSERT_SEED_FILE =
  "INSERT INTO supabase_migrations.seed_files(path, hash) VALUES($1, $2) ON CONFLICT (path) DO UPDATE SET hash = EXCLUDED.hash";
const SELECT_SEED_TABLE = "SELECT path, hash FROM supabase_migrations.seed_files";

/** A local seed file resolved from `[db.seed].sql_paths`, with its content hash. */
export interface LegacySeedFile {
  /** Workdir-relative, forward-slashed path (Go's `filepath.ToSlash`). */
  readonly path: string;
  /** Lowercase hex SHA-256 of the file content (Go's `NewSeedFile`). */
  readonly hash: string;
  /** True when the remote `seed_files` row has a different hash (re-hash only). */
  readonly dirty: boolean;
}

/** `SELECT path, hash FROM supabase_migrations.seed_files`, `42P01` → empty map. */
const readRemoteSeeds = (session: LegacyDbSession) =>
  session.query(SELECT_SEED_TABLE).pipe(
    Effect.map((rows) => {
      const applied = new Map<string, string>();
      for (const row of rows) applied.set(String(row["path"]), String(row["hash"]));
      return applied;
    }),
    Effect.catch((error: LegacyDbExecError) =>
      isUndefinedTable(error) ? Effect.succeed(new Map<string, string>()) : Effect.fail(error),
    ),
  );

const isUndefinedTable = (error: LegacyDbExecError): boolean =>
  error.code !== undefined
    ? error.code === "42P01"
    : /relation .* does not exist/iu.test(error.message) &&
      !/column .* does not exist/iu.test(error.message);

/**
 * Resolves the pending seed files for `db push --include-seed`. Mirrors Go's
 * `GetPendingSeeds` (`pkg/migration/seed.go:34-63`): glob the configured paths via
 * the shared {@link legacySqlFilesGlob} traversal (also used by `[db.migrations].
 * schema_paths`, `legacy-migration-apply.ts`, and by `legacy-seed.ts`'s own
 * `resolveSeedFiles` for the `migration down`/`start` seed step), warn — don't fail —
 * on empty patterns, read the remote `seed_files` hashes, and emit each local file
 * that is new (`dirty=false`) or hash-changed (`dirty=true`); files whose hash
 * already matches are skipped. Per-pattern warnings are joined with Go's `errors.Join`
 * newline semantics and surfaced unconditionally (`seed.go:36-38`) — unlike the
 * schema-files apply path (see `legacyApplySchemaFiles`), which only surfaces a
 * warning when it is the ONLY outcome.
 */
export const legacyGetPendingSeeds = Effect.fnUntraced(function* (
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  patterns: ReadonlyArray<string>,
  workdir: string,
) {
  const output = yield* Output;
  const { files, warnings } = yield* legacySqlFilesGlob(fs, path, patterns, workdir);
  if (warnings.length > 0) {
    yield* output.raw(`WARN: ${warnings.join("\n")}\n`, "stderr");
  }
  const pending: Array<LegacySeedFile> = [];
  if (files.length === 0) return pending;

  const applied = yield* readRemoteSeeds(session);
  for (const file of files) {
    // Go's `NewSeedFile` hashes the raw file stream (`io.Copy`, `pkg/migration/file.go:184`),
    // so hash the bytes — not a UTF-8-decoded string, which replaces invalid sequences and
    // would drift from the Go-recorded `seed_files` hash for a non-UTF-8 seed (SQL_ASCII dump
    // / binary COPY payload), spuriously re-running it across a Go ↔ native switch.
    const content = yield* fs.readFile(path.isAbsolute(file) ? file : path.join(workdir, file));
    const hash = createHash("sha256").update(content).digest("hex");
    const appliedHash = applied.get(file);
    if (appliedHash !== undefined) {
      if (appliedHash === hash) continue; // Already applied, unchanged.
      pending.push({ path: file, hash, dirty: true });
      continue;
    }
    pending.push({ path: file, hash, dirty: false });
  }
  return pending;
});

/**
 * Applies pending seed files. Mirrors Go's `SeedData` + `ExecBatchWithCache`
 * (`pkg/migration/seed.go:65-83`, `file.go:198-217`): create the `seed_files`
 * table, then per file emit the dirty/clean status line and, in one transaction,
 * run the file's statements (skipped when dirty — only the hash is refreshed)
 * followed by the `seed_files` hash upsert.
 */
export const legacySeedData = <E>(
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  workdir: string,
  path: Path.Path,
  seeds: ReadonlyArray<LegacySeedFile>,
  mapError: (message: string) => E,
): Effect.Effect<void, E, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    if (seeds.length === 0) return;
    // Go's `CreateSeedTable` (history.go:54-64) runs `SET lock_timeout = '4s'` +
    // schema/table DDL in one implicit transaction, so a conflicting schema/table lock
    // fails promptly but the timeout reverts on COMMIT and never leaks into the seed
    // SQL run below. `legacyCreateSeedTable` reproduces that with BEGIN + SET LOCAL +
    // DDL + COMMIT (creating the schema first so a seed-only run doesn't fail).
    yield* legacyCreateSeedTable(session);
    for (const seed of seeds) {
      yield* output.raw(
        seed.dirty
          ? `Updating seed hash to ${seed.path}...\n`
          : `Seeding data from ${seed.path}...\n`,
        "stderr",
      );
      // Go's `ExecBatchWithCache` parses the file (read + `SplitAndTrim`)
      // UNCONDITIONALLY before the dirty check (`file.go:198-211`), so a dirty seed
      // that is unreadable or contains malformed SQL still fails and leaves the
      // previous hash — only the queueing of statements is gated on `Dirty`. Parsing
      // includes the same `SUPABASE_SCANNER_BUFFER_SIZE` enforcement every other
      // `parseFile` caller gets (`checkScannerBufferSize`'s own doc comment) — Go's
      // `SeedFile.ExecBatchWithCache` runs through the identical `parseFile`, so an
      // oversized seed statement must fail here too, not execute silently.
      const content = yield* fs.readFileString(
        path.isAbsolute(seed.path) ? seed.path : path.join(workdir, seed.path),
      );
      yield* checkScannerBufferSize(content, (message) => new Error(message));
      const lines = legacySplitAndTrim(content);
      const statements = seed.dirty ? [] : lines;
      yield* legacyWarnResetRoleDrift(session, statements, seed.path);
      yield* session.exec("BEGIN");
      const body = Effect.gen(function* () {
        for (const statement of statements) yield* session.exec(statement);
        // A seed's own `RESET ROLE` reverts a stepped-down session to the login
        // role; restore `postgres` before the CLI-owned upsert (supabase/cli#6236).
        if (session.restoreRoleSql !== undefined) yield* session.exec(session.restoreRoleSql);
        yield* session.query(UPSERT_SEED_FILE, [seed.path, seed.hash]);
        yield* session.exec("COMMIT");
      });
      yield* body.pipe(Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore)));
    }
  }).pipe(
    Effect.mapError((error) =>
      mapError(
        typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
          ? error.message
          : String(error),
      ),
    ),
  );
