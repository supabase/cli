import { createHash } from "node:crypto";
import { Effect, type FileSystem, Option, type Path } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import type { LegacyDbExecError } from "../../../shared/legacy-db-connection.errors.ts";
import type { LegacyDbSession } from "../../../shared/legacy-db-connection.service.ts";
import { legacySplitAndTrim } from "../../../shared/legacy-sql-split.ts";

/**
 * Seed-history DDL/DML, verbatim from Go's `pkg/migration/history.go`.
 */
const CREATE_SEED_TABLE =
  "CREATE TABLE IF NOT EXISTS supabase_migrations.seed_files (path text NOT NULL PRIMARY KEY, hash text NOT NULL)";
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
    // Go joins each configured pattern under SupabaseDirPath before globbing.
    const pattern = toSlash(path.join("supabase", rawPattern));
    const matches = yield* globOne(fs, path, workdir, pattern);
    if (matches.length === 0) {
      errors.push(`no files matched pattern: ${pattern}`);
      continue;
    }
    for (const match of [...matches].sort()) {
      const fp = toSlash(match);
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
    // No metacharacters: a direct existence check (Go's `fs.Glob` fast path).
    if (!META_CHARS.test(pattern)) {
      const exists = yield* fs
        .exists(path.join(workdir, pattern))
        .pipe(Effect.orElseSucceed(() => false));
      return exists ? [pattern] : [];
    }
    const { dir, file } = splitPath(pattern);
    // Resolve the directory level first (recursively if it, too, is a glob).
    const dirs =
      dir === "" || !META_CHARS.test(dir) ? [dir] : yield* globOne(fs, path, workdir, dir);
    const result: Array<string> = [];
    for (const d of dirs) {
      const absDir = d === "" ? workdir : path.join(workdir, d);
      const names = yield* fs
        .readDirectory(absDir)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      for (const name of names) {
        if (legacyMatchPattern(file, name)) {
          result.push(d === "" ? name : `${d}/${name}`);
        }
      }
    }
    return result;
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
  if (files.length === 0) return [] as ReadonlyArray<LegacySeedFile>;

  const applied = yield* readRemoteSeeds(session);
  const pending: Array<LegacySeedFile> = [];
  for (const file of files) {
    const content = yield* fs.readFileString(path.join(workdir, file));
    const hash = createHash("sha256").update(content).digest("hex");
    const appliedHash = applied.get(file);
    if (appliedHash !== undefined) {
      if (appliedHash === hash) continue; // Already applied, unchanged.
      pending.push({ path: file, hash, dirty: true });
      continue;
    }
    pending.push({ path: file, hash, dirty: false });
  }
  return pending as ReadonlyArray<LegacySeedFile>;
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
    yield* session.exec(CREATE_SEED_TABLE);
    for (const seed of seeds) {
      yield* output.raw(
        seed.dirty
          ? `Updating seed hash to ${seed.path}...\n`
          : `Seeding data from ${seed.path}...\n`,
        "stderr",
      );
      const statements = seed.dirty
        ? []
        : legacySplitAndTrim(yield* fs.readFileString(path.join(workdir, seed.path)));
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
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error),
      ),
    ),
  );
