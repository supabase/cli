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

/** Applying a seed file failed (`SeedData` / `ExecBatchWithCache` errors). */
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

// Only metadata is kept during the pending scan — the decoded statements are NOT
// retained. `SeedFile` holds just
// `{Path, Hash, Dirty}` and re-parses each file individually inside the apply loop
// ("Parse each file individually to reduce memory usage"), so a
// large/many-file seed set never has every file's statements in memory at once.
interface PendingSeed {
  readonly path: string;
  readonly hash: string;
  readonly dirty: boolean;
}

/**
 * Resolves `[db.seed].sql_paths` to existing files, porting `config.Glob.SQLFiles`
 * (via the shared {@link sqlFilesGlob} traversal —
 * also used by `getPendingSeeds` (`seed-ops.ts`) for the same field on
 * the `db push`/`db reset` path, and by `applySchemaFiles` (`migration-apply.ts`)
 * for `[db.migrations].schema_paths`). `GetPendingSeeds` prints a single unconditional
 * `WARN: <joined>` line for any glob problem — unlike the schema-files
 * apply path, which only warns when NO pattern matched anything at all.
 */
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
 * Applies pending seed files, port of `applySeedFiles` + `GetPendingSeeds` +
 * `SeedData`:
 * gated on `db.seed.enabled`; a new seed runs its statements + records its hash;
 * a changed seed only updates the recorded hash ("dirty" → skip statements);
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
      if (previous === hash) continue; // unchanged → skip entirely
      // Keep only metadata; the statements are read + split per-file in the apply loop
      // below (each file is hashed up front via io.Copy in `NewSeedFile` but does not
      // retain its contents).
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
      // statements are in memory at a time, matching `ExecBatchWithCache` →
      // `parseFile` inside the apply loop. A dirty seed only
      // updates its recorded hash, so Go never re-reads it — skip the read.
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
        // `SeedFile.ExecBatchWithCache` parses through the same `parseFile` every
        // other caller does, so it enforces `SUPABASE_SCANNER_BUFFER_SIZE` here too —
        // see `checkScannerBufferSize`'s own doc comment.
        yield* checkScannerBufferSize(content, (message) => new MigrationSeedError({ message }));
        statements = splitAndTrim(content);
      }
      const txn = Effect.gen(function* () {
        yield* session.exec("BEGIN");
        if (!seed.dirty) {
          for (const statement of statements) {
            yield* session.exec(statement);
            // A top-level role revert drops a stepped-down session to the login
            // role; restore `postgres` right away (supabase/cli#6236).
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
