import { createHash } from "node:crypto";
import { Effect, type FileSystem, type Path } from "effect";

import { Output } from "../shared/output/output.service.ts";
import type { DbExecError } from "./db-connection.errors.ts";
import type { DbSession } from "./db-connection.service.ts";
import { checkScannerBufferSize, revertsToLoginRole } from "./migration-apply.ts";
import { createSeedTable } from "./migration-history.ts";
import { sqlFilesGlob } from "./sql-files-glob.ts";
import { splitAndTrim } from "./sql-split.ts";

// Seed-history DML; the schema/table DDL (with a transaction-scoped lock timeout) lives in
// `createSeedTable`.
const UPSERT_SEED_FILE =
  "INSERT INTO supabase_migrations.seed_files(path, hash) VALUES($1, $2) ON CONFLICT (path) DO UPDATE SET hash = EXCLUDED.hash";
const SELECT_SEED_TABLE = "SELECT path, hash FROM supabase_migrations.seed_files";

/** A local seed file resolved from `[db.seed].sql_paths`, with its content hash. */
export interface SeedFile {
  /** Workdir-relative, forward-slashed path. */
  readonly path: string;
  /** Lowercase hex SHA-256 of the file content. */
  readonly hash: string;
  /** True when the remote `seed_files` row has a different hash (re-hash only). */
  readonly dirty: boolean;
}

/** `SELECT path, hash FROM supabase_migrations.seed_files`, `42P01` → empty map. */
const readRemoteSeeds = (session: DbSession) =>
  session.query(SELECT_SEED_TABLE).pipe(
    Effect.map((rows) => {
      const applied = new Map<string, string>();
      for (const row of rows) applied.set(String(row["path"]), String(row["hash"]));
      return applied;
    }),
    Effect.catch((error: DbExecError) =>
      isUndefinedTable(error) ? Effect.succeed(new Map<string, string>()) : Effect.fail(error),
    ),
  );

const isUndefinedTable = (error: DbExecError): boolean =>
  error.code !== undefined
    ? error.code === "42P01"
    : /relation .* does not exist/iu.test(error.message) &&
      !/column .* does not exist/iu.test(error.message);

/**
 * Resolves the pending seed files for `db push --include-seed`: globs the configured
 * patterns via {@link sqlFilesGlob}, warns (without failing) on empty patterns, reads the
 * remote `seed_files` hashes, and emits each local file that is new (`dirty=false`) or
 * hash-changed (`dirty=true`), skipping files whose hash already matches. Unlike
 * `applySchemaFiles`, per-pattern warnings are always surfaced, not only when that's the sole outcome.
 */
export const getPendingSeeds = Effect.fnUntraced(function* (
  session: DbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  patterns: ReadonlyArray<string>,
  workdir: string,
) {
  const output = yield* Output;
  const { files, warnings } = yield* sqlFilesGlob(fs, path, patterns, workdir);
  if (warnings.length > 0) {
    yield* output.raw(`WARN: ${warnings.join("\n")}\n`, "stderr");
  }
  const pending: Array<SeedFile> = [];
  if (files.length === 0) return pending;

  const applied = yield* readRemoteSeeds(session);
  for (const file of files) {
    // Hashes the raw bytes, not a UTF-8-decoded string: decoding would replace invalid
    // sequences in a non-UTF-8 seed (SQL_ASCII dump / binary COPY payload) and silently
    // change its hash.
    const content = yield* fs.readFile(path.isAbsolute(file) ? file : path.join(workdir, file));
    const hash = createHash("sha256").update(content).digest("hex");
    const appliedHash = applied.get(file);
    if (appliedHash !== undefined) {
      if (appliedHash === hash) continue;
      pending.push({ path: file, hash, dirty: true });
      continue;
    }
    pending.push({ path: file, hash, dirty: false });
  }
  return pending;
});

/**
 * Applies pending seed files: creates the `seed_files` table, then per file emits the
 * dirty/clean status line and, in one transaction, runs the file's statements (skipped when
 * dirty — only the hash is refreshed) followed by the `seed_files` hash upsert.
 */
export const seedData = <E>(
  session: DbSession,
  fs: FileSystem.FileSystem,
  workdir: string,
  path: Path.Path,
  seeds: ReadonlyArray<SeedFile>,
  mapError: (message: string) => E,
): Effect.Effect<void, E, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    if (seeds.length === 0) return;
    // `createSeedTable` runs BEGIN + SET LOCAL lock_timeout + schema/table DDL + COMMIT, so
    // a conflicting lock fails promptly but the timeout never leaks into the seed SQL below.
    yield* createSeedTable(session);
    for (const seed of seeds) {
      yield* output.raw(
        seed.dirty
          ? `Updating seed hash to ${seed.path}...\n`
          : `Seeding data from ${seed.path}...\n`,
        "stderr",
      );
      // The file is read and parsed unconditionally, before the dirty check, so an
      // unreadable or malformed dirty seed still fails (leaving the previous hash) — only
      // the queueing of statements is gated on `dirty`. This also applies the same
      // `SUPABASE_SCANNER_BUFFER_SIZE` enforcement as any other `parseFile` caller.
      const content = yield* fs.readFileString(
        path.isAbsolute(seed.path) ? seed.path : path.join(workdir, seed.path),
      );
      yield* checkScannerBufferSize(content, (message) => new Error(message));
      const lines = splitAndTrim(content);
      const statements = seed.dirty ? [] : lines;
      yield* session.exec("BEGIN");
      const body = Effect.gen(function* () {
        for (const statement of statements) {
          yield* session.exec(statement);
          // A top-level role revert drops a stepped-down session to the login role; restore
          // `postgres` immediately so later statements run with the expected privileges.
          if (session.restoreRoleSql !== undefined && revertsToLoginRole(statement)) {
            yield* session.exec(session.restoreRoleSql);
          }
        }
        // Backstop for reverts the lexical check cannot see, so the
        // CLI-owned upsert always runs as `postgres`.
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
