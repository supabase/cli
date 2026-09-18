import { createHash } from "node:crypto";
import { Data, Effect, FileSystem, Path } from "effect";

import { Output } from "../shared/output/output.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import type { DbSession } from "./db-connection.service.ts";
import { resolveUnderWorkdir } from "./glob.ts";
import { checkScannerBufferSize, revertsToLoginRole } from "./migration-apply.ts";
import { createSeedTable, readSeedTable, UPSERT_SEED_FILE } from "./migration-history.ts";
import { sqlFilesGlob } from "./sql-files-glob.ts";
import { splitAndTrim } from "./sql-split.ts";

/** Applying a seed file failed. */
export class MigrationSeedError extends Data.TaggedError("MigrationSeedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/** `[db.seed]` config: `enabled` + the (supabase-prefixed) `sql_paths` glob list. */
export interface SeedConfig {
  readonly enabled: boolean;
  readonly sqlPaths: ReadonlyArray<string>;
}

// Only metadata is kept during the pending scan; each file's statements are re-parsed
// individually in the apply loop, so a large/many-file seed set never holds every file's
// statements in memory at once.
interface PendingSeed {
  readonly path: string;
  readonly hash: string;
  readonly dirty: boolean;
}

// Resolves `[db.seed].sql_paths` to existing files via the shared {@link sqlFilesGlob}
// traversal, printing a single `WARN: <joined>` line for any glob problem — unlike the
// schema-files apply path, which only warns when no pattern matched anything at all.
const resolveSeedFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  patterns: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const output = yield* Output;
    const { files, warnings } = yield* sqlFilesGlob(fs, path, patterns, workdir);
    if (warnings.length > 0) yield* output.raw(`WARN: ${warnings.join("\n")}\n`, "stderr");
    return files;
  });

/**
 * Applies pending seed files, gated on `db.seed.enabled`: a new seed runs its statements
 * and records its hash; a changed seed only updates the recorded hash (skipping statements);
 * an unchanged seed is skipped entirely.
 */
export const applySeedFiles = (
  session: DbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  config: SeedConfig,
) =>
  Effect.gen(function* () {
    const output = yield* Output;
    if (!config.enabled) return;

    const locals = yield* resolveSeedFiles(fs, path, workdir, config.sqlPaths);
    if (locals.length === 0) return;

    const applied = new Map(
      (yield* readSeedTable(session).pipe(
        Effect.mapError((cause) => new MigrationSeedError({ message: cause.message })),
      )).map((row) => [row.path, row.hash] as const),
    );

    const pending: Array<PendingSeed> = [];
    for (const relativePath of locals) {
      const content = yield* fs.readFile(resolveUnderWorkdir(path, workdir, relativePath)).pipe(
        Effect.mapError(
          (cause) =>
            new MigrationSeedError({
              message: `failed to open seed file: ${cause.message}`,
            }),
        ),
      );
      const hash = createHash("sha256").update(content).digest("hex");
      const previous = applied.get(relativePath);
      if (previous === hash) continue;
      // Keep only metadata; statements are read and split per-file in the apply loop below.
      pending.push({
        path: relativePath,
        hash,
        dirty: previous !== undefined, // recorded but changed → only update the hash
      });
    }
    if (pending.length === 0) return;

    yield* createSeedTable(session).pipe(
      Effect.mapError(
        (cause) =>
          new MigrationSeedError({
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
      // statements are in memory at a time. A dirty seed only updates its recorded hash,
      // so its content is never read.
      let statements: ReadonlyArray<string> = [];
      if (!seed.dirty) {
        const content = new TextDecoder().decode(
          yield* fs.readFile(resolveUnderWorkdir(path, workdir, seed.path)).pipe(
            Effect.mapError(
              (cause) =>
                new MigrationSeedError({
                  message: `failed to open seed file: ${cause.message}`,
                }),
            ),
          ),
        );
        // Enforces the same `SUPABASE_SCANNER_BUFFER_SIZE` limit as any other `parseFile`
        // caller — see `checkScannerBufferSize`'s own doc comment.
        yield* checkScannerBufferSize(content, (message) => new MigrationSeedError({ message }));
        statements = splitAndTrim(content);
      }
      const txn = Effect.gen(function* () {
        yield* session.exec("BEGIN");
        if (!seed.dirty) {
          for (const statement of statements) {
            yield* session.exec(statement);
            // A top-level role revert drops a stepped-down session to the login role;
            // restore `postgres` immediately so later statements run with the expected
            // privileges.
            if (session.restoreRoleSql !== undefined && revertsToLoginRole(statement)) {
              yield* session.exec(session.restoreRoleSql);
            }
          }
        }
        // Backstop for reverts the lexical check cannot see, so the
        // CLI-owned upsert always runs as `postgres`.
        if (session.restoreRoleSql !== undefined) yield* session.exec(session.restoreRoleSql);
        yield* session.query(UPSERT_SEED_FILE, [seed.path, seed.hash]);
        yield* session.exec("COMMIT");
      });
      yield* txn.pipe(
        Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore)),
        Effect.mapError(
          (cause) => new MigrationSeedError({ message: `failed to send batch: ${cause.message}` }),
        ),
      );
    }
  });
