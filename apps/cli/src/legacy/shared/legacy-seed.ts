import { createHash } from "node:crypto";
import { Data, Effect, FileSystem, Path } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import {
  legacyCreateSeedTable,
  legacyReadSeedTable,
  UPSERT_SEED_FILE,
} from "./legacy-migration-history.ts";
import { LEGACY_BAD_PATTERN_MESSAGE, legacyPathMatch } from "./legacy-path-match.ts";
import { legacySplitAndTrim } from "./legacy-sql-split.ts";

/** Applying a seed file failed (Go's `SeedData` / `ExecBatchWithCache` errors). */
export class LegacyMigrationSeedError extends Data.TaggedError("LegacyMigrationSeedError")<{
  readonly message: string;
}> {}

/** `[db.seed]` config: `enabled` + the (supabase-prefixed) `sql_paths` glob list. */
export interface LegacySeedConfig {
  readonly enabled: boolean;
  readonly sqlPaths: ReadonlyArray<string>;
}

interface LegacyPendingSeed {
  readonly path: string;
  readonly hash: string;
  readonly statements: ReadonlyArray<string>;
  readonly dirty: boolean;
}

const hasMeta = (pattern: string): boolean => /[*?[]/u.test(pattern);

// Go globs/reads seed paths through an OS-root-rooted `afero.NewOsFs`, where the
// CLI's "workdir" is just `os.Chdir(workdir)` (`internal/utils/misc.go`) — which
// only affects RELATIVE paths. An absolute `[db.seed].sql_paths` entry, preserved
// verbatim by the config loader (`pkg/config/config.go`, gated on `!filepath.IsAbs`),
// therefore resolves at the OS root, never under the workdir. Mirror that: only
// join under the workdir when the path is relative (`path.join` would otherwise
// collapse `/repo` + `/tmp/seed.sql` to `/repo/tmp/seed.sql`).
const resolveUnderWorkdir = (path: Path.Path, workdir: string, p: string): string =>
  path.isAbsolute(p) ? p : path.join(workdir, p);

/**
 * Resolves a single glob pattern against the workdir, returning the matched
 * paths RELATIVE to the workdir (so `seed_files.path` stays Go-compatible).
 * Mirrors Go's `fs.Glob`: a literal pattern returns itself iff it exists; a
 * pattern with metacharacters lists each parent directory and matches per
 * segment via `legacyPathMatch` (Go's `path.Match`). The caller validates the
 * whole pattern up front, so a malformed class never reaches here.
 */
const globPattern = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  pattern: string,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    if (!hasMeta(pattern)) {
      const exists = yield* fs
        .exists(resolveUnderWorkdir(path, workdir, pattern))
        .pipe(Effect.orElseSucceed(() => false));
      return exists ? [pattern] : [];
    }
    const slash = pattern.lastIndexOf("/");
    const dirPattern = slash === -1 ? "" : pattern.slice(0, slash);
    const filePattern = slash === -1 ? pattern : pattern.slice(slash + 1);
    const dirs = hasMeta(dirPattern)
      ? yield* globPattern(fs, path, workdir, dirPattern)
      : [dirPattern];
    const result: Array<string> = [];
    for (const dir of dirs) {
      const absDir = dir.length === 0 ? workdir : resolveUnderWorkdir(path, workdir, dir);
      const names = yield* fs.readDirectory(absDir).pipe(Effect.orElseSucceed(() => []));
      for (const name of names) {
        if (legacyPathMatch(filePattern, name).matched) {
          result.push(dir.length === 0 ? name : `${dir}/${name}`);
        }
      }
    }
    return result;
  });

/** Go's `config.Glob.Files`: glob each pattern, sort, dedup; warn on bad/no-match. */
const resolveSeedFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  patterns: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const output = yield* Output;
    const seen = new Set<string>();
    const result: Array<string> = [];
    const unmatched: Array<string> = [];
    for (const pattern of patterns) {
      // Go's `fs.Glob` validates the whole pattern up front (`Match(pattern, "")`);
      // a malformed glob is reported as `failed to glob files: <ErrBadPattern>` and
      // contributes no matches, exactly like `Glob.Files`'s error branch.
      if (legacyPathMatch(pattern, "").badPattern) {
        unmatched.push(`failed to glob files: ${LEGACY_BAD_PATTERN_MESSAGE}`);
        continue;
      }
      const matches = [...(yield* globPattern(fs, path, workdir, pattern))].sort();
      if (matches.length === 0) unmatched.push(`no files matched pattern: ${pattern}`);
      for (const match of matches) {
        if (!seen.has(match)) {
          seen.add(match);
          result.push(match);
        }
      }
    }
    // Go collects all glob errors into one `errors.Join` and prints a single
    // `WARN: <joined>` line (`config.Glob.Files` → `seed.go:37`), not one per pattern.
    if (unmatched.length > 0) yield* output.raw(`WARN: ${unmatched.join("\n")}\n`, "stderr");
    return result;
  });

/**
 * Applies pending seed files, port of Go's `applySeedFiles` + `GetPendingSeeds` +
 * `SeedData` (`internal/migration/apply/apply.go:40`, `pkg/migration/seed.go`):
 * gated on `db.seed.enabled`; a new seed runs its statements + records its hash;
 * a changed seed only updates the recorded hash (Go's "dirty" → skip statements);
 * an unchanged seed is skipped entirely.
 */
export const legacyApplySeedFiles = (
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  config: LegacySeedConfig,
) =>
  Effect.gen(function* () {
    const output = yield* Output;
    if (!config.enabled) return;

    const locals = yield* resolveSeedFiles(fs, path, workdir, config.sqlPaths);
    if (locals.length === 0) return;

    const applied = new Map(
      (yield* legacyReadSeedTable(session).pipe(
        Effect.mapError((cause) => new LegacyMigrationSeedError({ message: cause.message })),
      )).map((row) => [row.path, row.hash] as const),
    );

    const pending: Array<LegacyPendingSeed> = [];
    for (const relativePath of locals) {
      const content = yield* fs.readFile(resolveUnderWorkdir(path, workdir, relativePath)).pipe(
        Effect.mapError(
          (cause) =>
            new LegacyMigrationSeedError({
              message: `failed to open seed file: ${cause.message}`,
            }),
        ),
      );
      const hash = createHash("sha256").update(content).digest("hex");
      const previous = applied.get(relativePath);
      if (previous === hash) continue; // unchanged → skip entirely
      pending.push({
        path: relativePath,
        hash,
        statements: legacySplitAndTrim(new TextDecoder().decode(content)),
        dirty: previous !== undefined, // recorded but changed → only update the hash
      });
    }
    if (pending.length === 0) return;

    yield* legacyCreateSeedTable(session).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyMigrationSeedError({
            message: `failed to create seed table: ${cause.message}`,
          }),
      ),
    );

    for (const seed of pending) {
      yield* output.raw(
        seed.dirty
          ? `Updating seed hash to ${seed.path}...\n`
          : `Seeding data from ${seed.path}...\n`,
        "stderr",
      );
      const txn = Effect.gen(function* () {
        yield* session.exec("BEGIN");
        if (!seed.dirty) {
          for (const statement of seed.statements) yield* session.exec(statement);
        }
        yield* session.query(UPSERT_SEED_FILE, [seed.path, seed.hash]);
        yield* session.exec("COMMIT");
      });
      yield* txn.pipe(
        Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore)),
        Effect.mapError(
          (cause) =>
            new LegacyMigrationSeedError({ message: `failed to send batch: ${cause.message}` }),
        ),
      );
    }
  });
