import { createHash } from "node:crypto";
import { Data, Effect, FileSystem, Path, Result } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import { legacyGlobPattern, legacyResolveUnderWorkdir, legacyWalkSqlFiles } from "./legacy-glob.ts";
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
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/** `[db.seed]` config: `enabled` + the (supabase-prefixed) `sql_paths` glob list. */
export interface LegacySeedConfig {
  readonly enabled: boolean;
  readonly sqlPaths: ReadonlyArray<string>;
}

// Only metadata is kept during the pending scan — the decoded statements are NOT
// retained. Go's `SeedFile` (`pkg/migration/file.go:178-182`) holds just
// `{Path, Hash, Dirty}` and re-parses each file individually inside the apply loop
// ("Parse each file individually to reduce memory usage", `file.go:198-203`), so a
// large/many-file seed set never has every file's statements in memory at once.
interface LegacyPendingSeed {
  readonly path: string;
  readonly hash: string;
  readonly dirty: boolean;
}

/**
 * Port of Go's `Glob.SQLFiles` (`pkg/config/config.go:122-128` → `files`/`walkMatchedDir`) as
 * called by `GetPendingSeeds` (`locals.SQLFiles(fsys)`, `pkg/migration/seed.go:35`) — the SAME
 * method `db.migrations.schema_paths` resolves through (`legacyResolveSchemaPathFiles` in
 * `legacy-migrate-and-seed.ts`), not the plainer `Glob.Files`: each pattern is glob-matched via
 * {@link legacyGlobPattern}, and a matched DIRECTORY is expanded to its sorted, regular `.sql`
 * files, recursively (via the shared {@link legacyWalkSqlFiles}), rather than kept as-is — a
 * plain glob match (e.g. `[db.seed] sql_paths = ["./seeds"]` with no metacharacters) previously
 * resolved a directory entry to itself, which then failed reading it as a seed file. A matched
 * plain file is kept as-is, even a non-`.sql` one, matching `expandDir`'s `IsDir()`-only gate.
 *
 * Unlike `legacyResolveSchemaPathFiles`, a bad pattern, an empty match, or a directory-walk
 * failure is NEVER a hard failure here — `GetPendingSeeds` only ever warns
 * (`fmt.Fprintln(os.Stderr, "WARN:", err)`) and proceeds with whatever it already collected,
 * even if that ends up empty (`len(locals) == 0` just means no pending seeds, not an error).
 */
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
      const matches = [...(yield* legacyGlobPattern(fs, path, workdir, pattern))].sort();
      if (matches.length === 0) unmatched.push(`no files matched pattern: ${pattern}`);
      for (const match of matches) {
        const absMatch = legacyResolveUnderWorkdir(path, workdir, match);
        const statResult = yield* fs.stat(absMatch).pipe(Effect.result);
        if (Result.isFailure(statResult)) {
          unmatched.push(`failed to stat matched file: ${match}`);
          continue;
        }
        if (statResult.success.type !== "Directory") {
          if (!seen.has(match)) {
            seen.add(match);
            result.push(match);
          }
          continue;
        }
        // Go's `walkMatchedDir`: recursively list the matched directory, keep only regular
        // `.sql` files, sorted (a global sort over the full relative-to-fsys-root path, not
        // per-directory — matches `sort.Strings(files)` running once after the whole walk).
        const namesResult = yield* legacyWalkSqlFiles(fs, absMatch, "").pipe(Effect.result);
        if (Result.isFailure(namesResult)) {
          unmatched.push(`failed to walk matched directory: ${match}`);
          continue;
        }
        const sqlRelative = [...namesResult.success].sort();
        for (const relative of sqlRelative) {
          const relativeToWorkdir = `${match}/${relative}`;
          if (!seen.has(relativeToWorkdir)) {
            seen.add(relativeToWorkdir);
            result.push(relativeToWorkdir);
          }
        }
      }
    }
    // Go collects all glob/walk errors into one `errors.Join` and prints a single
    // `WARN: <joined>` line (`Glob.SQLFiles` → `seed.go:35-36`), not one per pattern.
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
      const content = yield* fs
        .readFile(legacyResolveUnderWorkdir(path, workdir, relativePath))
        .pipe(
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
      // Keep only metadata; the statements are read + split per-file in the apply loop
      // below (Go hashes each file up front via io.Copy in `NewSeedFile` but does not
      // retain its contents, `file.go:184-196`).
      pending.push({
        path: relativePath,
        hash,
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
      // Read + split this seed's statements here (not up front) so only one file's
      // statements are in memory at a time, matching Go's `ExecBatchWithCache` →
      // `parseFile` inside the apply loop (`file.go:198-203`). A dirty seed only
      // updates its recorded hash, so Go never re-reads it — skip the read.
      const statements = seed.dirty
        ? []
        : legacySplitAndTrim(
            new TextDecoder().decode(
              yield* fs.readFile(legacyResolveUnderWorkdir(path, workdir, seed.path)).pipe(
                Effect.mapError(
                  (cause) =>
                    new LegacyMigrationSeedError({
                      message: `failed to open seed file: ${cause.message}`,
                    }),
                ),
              ),
            ),
          );
      const txn = Effect.gen(function* () {
        yield* session.exec("BEGIN");
        if (!seed.dirty) {
          for (const statement of statements) yield* session.exec(statement);
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
