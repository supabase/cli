import { createHash } from "node:crypto";
import { Effect, type FileSystem, Option, type Path } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import type { LegacyDbExecError } from "../../../shared/legacy-db-connection.errors.ts";
import type { LegacyDbSession } from "../../../shared/legacy-db-connection.service.ts";
import { legacyCreateSeedTable } from "../../../shared/legacy-migration-history.ts";
import { legacySplitAndTrim } from "../../../shared/legacy-sql-split.ts";

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

const META_CHARS = /[*?[\\]/u;

/**
 * Go's `path.Match` for a single filename (no `/`). Supports `*` (any run of
 * non-separator chars), `?` (one char), `[...]` classes with ranges and a
 * leading `^`/`!` negation, and `\` escapes. Filenames never contain `/`, so the
 * separator subtlety in Go's matcher does not apply here.
 */
export function legacyMatchPattern(pattern: string, name: string): boolean {
  const matchClass = (cls: string, ch: string): boolean => {
    let negated = false;
    let body = cls;
    if (body.startsWith("^") || body.startsWith("!")) {
      negated = true;
      body = body.slice(1);
    }
    let matched = false;
    for (let k = 0; k < body.length; k++) {
      if (body[k + 1] === "-" && k + 2 < body.length) {
        if (ch >= body[k]! && ch <= body[k + 2]!) matched = true;
        k += 2;
      } else if (body[k] === ch) {
        matched = true;
      }
    }
    return matched !== negated;
  };

  const match = (p: number, n: number): boolean => {
    while (p < pattern.length) {
      const pc = pattern[p]!;
      if (pc === "*") {
        // Collapse consecutive stars, then try to match the rest at every offset.
        while (pattern[p] === "*") p++;
        if (p === pattern.length) return true;
        for (let k = n; k <= name.length; k++) {
          if (match(p, k)) return true;
        }
        return false;
      }
      if (n >= name.length) return false;
      if (pc === "?") {
        p++;
        n++;
        continue;
      }
      if (pc === "[") {
        const end = pattern.indexOf("]", p + 1);
        if (end === -1) return false;
        if (!matchClass(pattern.slice(p + 1, end), name[n]!)) return false;
        p = end + 1;
        n++;
        continue;
      }
      if (pc === "\\" && p + 1 < pattern.length) {
        if (pattern[p + 1] !== name[n]) return false;
        p += 2;
        n++;
        continue;
      }
      if (pc !== name[n]) return false;
      p++;
      n++;
    }
    return n === name.length;
  };

  return match(0, 0);
}

/** Result of resolving `[db.seed].sql_paths` against the workspace. */
interface LegacyGlobResult {
  /** Workdir-relative, forward-slashed matches, deduplicated in pattern order. */
  readonly files: ReadonlyArray<string>;
  /** Per-pattern warnings (`no files matched pattern: …`), joined by Go's `errors.Join`. */
  readonly warning: Option.Option<string>;
}

/**
 * Resolves seed glob patterns to existing files, porting Go's `config.Glob.Files`
 * over `fs.Glob` (`pkg/config/config.go:102-124`). Each pattern is first joined
 * under the `supabase/` directory (Go resolves `sql_paths` at config load,
 * `config.go:884`). Matches per pattern are sorted; the overall result preserves
 * first-seen order across patterns. A pattern that matches nothing contributes a
 * `no files matched pattern: <pattern>` warning but is not fatal.
 */
const legacyGlobSeedFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  patterns: ReadonlyArray<string>,
  workdir: string,
) {
  const seen = new Set<string>();
  const files: Array<string> = [];
  const errors: Array<string> = [];

  for (const rawPattern of patterns) {
    // Patterns arrive already resolved to Go's config-load form (relative entries
    // supabase/-joined, absolute preserved) via `legacyResolveSeedSqlPath` — the reader
    // for `[db.seed].sql_paths`, the caller for `--sql-paths`. Go's `config.Glob.Files`
    // globs those resolved paths without re-prefixing (`config.go:102-124`), so only
    // normalize separators here; re-joining `supabase/` would double-prefix.
    const pattern = toSlash(rawPattern);
    const matches = yield* globOne(fs, path, workdir, pattern);
    if (matches.length === 0) {
      errors.push(`no files matched pattern: ${pattern}`);
      continue;
    }
    for (const match of [...matches].sort()) {
      const fp = toSlash(match);
      // Go's `GetPendingSeeds` globs via `Glob.SQLFiles`, which `Stat`s each match: a
      // directory is expanded to its regular `.sql` files recursively (`walkMatchedDir`,
      // sorted) while a file match is kept verbatim (`config.go:157-183`). Without this a
      // directory `sql_paths` entry (e.g. `["seeds"]`) would flow into
      // `readFileString(<dir>)` and fail — Go's `db push --include-seed` / remote reset
      // seed the directory's SQL children instead.
      const matchType = yield* fs.stat(path.isAbsolute(fp) ? fp : path.join(workdir, fp)).pipe(
        Effect.map((info) => info.type),
        Effect.orElseSucceed(() => "File" as const),
      );
      if (matchType === "Directory") {
        for (const file of yield* legacyWalkSeedSqlFiles(fs, path, workdir, fp)) {
          if (!seen.has(file)) {
            seen.add(file);
            files.push(file);
          }
        }
        continue;
      }
      if (!seen.has(fp)) {
        seen.add(fp);
        files.push(fp);
      }
    }
  }

  return {
    files,
    warning: errors.length > 0 ? Option.some(errors.join("\n")) : Option.none(),
  } satisfies LegacyGlobResult;
});

const toSlash = (p: string): string => p.replaceAll("\\", "/");

/** Splits a forward-slashed path into its directory prefix and final element. */
const splitPath = (p: string): { readonly dir: string; readonly file: string } => {
  const slash = p.lastIndexOf("/");
  return slash === -1 ? { dir: "", file: p } : { dir: p.slice(0, slash), file: p.slice(slash + 1) };
};

/** Faithful port of Go's `fs.Glob` for one pattern, rooted at `workdir`. */
const globOne = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  pattern: string,
): Effect.Effect<ReadonlyArray<string>, never> =>
  Effect.gen(function* () {
    // Absolute patterns resolve against the filesystem root (Go preserves absolute
    // seed paths); relative ones are rooted at the workdir.
    const resolve = (p: string): string => (path.isAbsolute(p) ? p : path.join(workdir, p));
    // No metacharacters: a direct existence check (Go's `fs.Glob` fast path).
    if (!META_CHARS.test(pattern)) {
      const exists = yield* fs.exists(resolve(pattern)).pipe(Effect.orElseSucceed(() => false));
      return exists ? [pattern] : [];
    }
    const { dir, file } = splitPath(pattern);
    // Resolve the directory level first (recursively if it, too, is a glob).
    const dirs =
      dir === "" || !META_CHARS.test(dir) ? [dir] : yield* globOne(fs, path, workdir, dir);
    const result: Array<string> = [];
    for (const d of dirs) {
      const absDir = d === "" ? workdir : resolve(d);
      const names = yield* fs
        .readDirectory(absDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const name of names) {
        if (legacyMatchPattern(file, name)) {
          result.push(d === "" ? name : `${d}/${name}`);
        }
      }
    }
    return result;
  });

/**
 * Recursively collects the regular `.sql` files under a matched seed directory, porting
 * Go's `walkMatchedDir` with the `SQLFiles` include filter (`entry.Type().IsRegular() &&
 * filepath.Ext(path) == ".sql"`, `config.go:126-131,194-211`). Paths are workdir-relative
 * (matching the glob output), forward-slashed, and sorted for deterministic application.
 */
const legacyWalkSeedSqlFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  dir: string,
): Effect.Effect<ReadonlyArray<string>, never> =>
  Effect.gen(function* () {
    const collected: Array<string> = [];
    const walk = (rel: string): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const absDir = path.isAbsolute(rel) ? rel : path.join(workdir, rel);
        const names = yield* fs
          .readDirectory(absDir)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        for (const name of names) {
          const childRel = `${rel}/${name}`;
          const childType = yield* fs
            .stat(path.isAbsolute(childRel) ? childRel : path.join(workdir, childRel))
            .pipe(
              Effect.map((info) => info.type),
              Effect.orElseSucceed(() => "Unknown" as const),
            );
          if (childType === "Directory") {
            yield* walk(childRel);
          } else if (childType === "File" && childRel.endsWith(".sql")) {
            collected.push(toSlash(childRel));
          }
        }
      });
    yield* walk(dir);
    return collected.sort();
  });

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
 * `GetPendingSeeds` (`pkg/migration/seed.go:34-63`): glob the configured paths
 * (warn, don't fail, on empty patterns), read the remote `seed_files` hashes,
 * and emit each local file that is new (`dirty=false`) or hash-changed
 * (`dirty=true`); files whose hash already matches are skipped.
 */
export const legacyGetPendingSeeds = Effect.fnUntraced(function* (
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  patterns: ReadonlyArray<string>,
  workdir: string,
) {
  const output = yield* Output;
  const { files, warning } = yield* legacyGlobSeedFiles(fs, path, patterns, workdir);
  if (Option.isSome(warning)) {
    yield* output.raw(`WARN: ${warning.value}\n`, "stderr");
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
      // previous hash — only the queueing of statements is gated on `Dirty`.
      const lines = legacySplitAndTrim(
        yield* fs.readFileString(
          path.isAbsolute(seed.path) ? seed.path : path.join(workdir, seed.path),
        ),
      );
      const statements = seed.dirty ? [] : lines;
      yield* session.exec("BEGIN");
      const body = Effect.gen(function* () {
        for (const statement of statements) yield* session.exec(statement);
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
