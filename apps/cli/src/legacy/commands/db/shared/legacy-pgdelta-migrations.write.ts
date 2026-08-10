import { Data, Effect, type FileSystem, type Path } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";
import { legacyMakeDir } from "../../../shared/legacy-make-dir.ts";
import {
  legacyFormatMigrationTimestamp,
  legacyGetMigrationPath,
} from "../../../shared/legacy-migration-file.ts";

/** A migration file written by a diff/pull, paired with its history version. */
export interface LegacyWrittenMigration {
  readonly path: string;
  readonly version: string;
}

/**
 * A write failure from `legacyWritePgDeltaMigrations`. Callers map this to their
 * own command-domain write error (`LegacyDbDiffWriteError` / `LegacyDbPullWriteError`).
 */
export class LegacyPgDeltaMigrationWriteError extends Data.TaggedError(
  "LegacyPgDeltaMigrationWriteError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * Bounds the base-timestamp bump retry so a directory already full of same-second
 * migrations can't spin forever. Mirrors Go's `maxVersionCollisionAttempts`.
 */
const MAX_VERSION_COLLISION_ATTEMPTS = 60;

/**
 * Port of Go's `WritePgDeltaMigrations` (`apps/cli-go/internal/db/diff/pgdelta_migrations.go`).
 *
 * Writes one ordered migration file per plan unit. A single-unit plan (the common
 * case) keeps the exact `<ts>_<name>.sql` filename; multi-unit plans append the
 * unit name and give each file a strictly increasing timestamp (real time
 * arithmetic on the base millis, never string increment) so their execution order
 * and migration-history order stay stable.
 *
 * Before writing anything the FULL set of generated filenames is collision-checked
 * against the filesystem: if any target path already exists the base is advanced by
 * one second and every version recomputed, so the set stays strictly ascending AND
 * unique against pre-existing migrations. The base only ever moves forward — never
 * backdated below the caller's wall clock, since backdating could sort a new file
 * before pre-existing migrations. The resulting ≤N−1s future-dating is inherent to
 * second-granularity versions and acceptable once uniqueness is enforced.
 *
 * Each file is written with the exclusive `"wx"` flag so a race between the
 * collision check and the write can still never silently overwrite an existing
 * migration. If any open/write fails mid-loop, every file already written by THIS
 * invocation is best-effort removed before the error surfaces (a removal failure
 * never masks the original error).
 */
export const legacyWritePgDeltaMigrations = (
  fs: FileSystem.FileSystem,
  pathSvc: Path.Path,
  opts: {
    readonly workdir: string;
    readonly baseMillis: number;
    readonly name: string;
    readonly files: ReadonlyArray<{ readonly name: string; readonly sql: string }>;
  },
): Effect.Effect<Array<LegacyWrittenMigration>, LegacyPgDeltaMigrationWriteError> =>
  Effect.gen(function* () {
    const { workdir, name, files } = opts;
    const single = files.length === 1;
    const buildSet = (baseMillis: number): Array<LegacyWrittenMigration> =>
      files.map((file, i) => {
        const version = legacyFormatMigrationTimestamp(baseMillis + i * 1000);
        const unitName = single ? name : `${name}_${file.name}`;
        return { path: legacyGetMigrationPath(pathSvc, workdir, version, unitName), version };
      });

    let baseMillis = opts.baseMillis;
    let set = buildSet(baseMillis);
    for (let attempt = 0; ; attempt++) {
      let collision = false;
      for (const w of set) {
        const exists = yield* fs.exists(w.path).pipe(
          Effect.mapError(
            (cause) =>
              new LegacyPgDeltaMigrationWriteError({
                message: `failed to check migration file: ${cause.message}`,
              }),
          ),
        );
        if (exists) {
          collision = true;
          break;
        }
      }
      if (!collision) break;
      if (attempt + 1 >= MAX_VERSION_COLLISION_ATTEMPTS) {
        return yield* Effect.fail(
          new LegacyPgDeltaMigrationWriteError({
            message: `failed to find a unique migration version after ${MAX_VERSION_COLLISION_ATTEMPTS} attempts`,
          }),
        );
      }
      baseMillis += 1000;
      set = buildSet(baseMillis);
    }

    const written: Array<LegacyWrittenMigration> = [];
    const writeAll = Effect.gen(function* () {
      for (let i = 0; i < files.length; i++) {
        const w = set[i]!;
        const file = files[i]!;
        yield* legacyMakeDir(fs, pathSvc.dirname(w.path)).pipe(
          Effect.mapError(
            (cause) => new LegacyPgDeltaMigrationWriteError({ message: cause.message }),
          ),
        );
        yield* fs.writeFileString(w.path, `${file.sql}\n`, { flag: "wx" }).pipe(
          Effect.mapError(
            (cause) =>
              new LegacyPgDeltaMigrationWriteError({
                message:
                  cause.reason._tag === "AlreadyExists"
                    ? `failed to open migration file: ${cause.message}`
                    : `failed to write migration file: ${cause.message}`,
              }),
          ),
        );
        written.push(w);
      }
      return written;
    });

    return yield* writeAll.pipe(
      Effect.tapError(() =>
        Effect.forEach(written, (w) => fs.remove(w.path).pipe(Effect.ignore), { discard: true }),
      ),
    );
  });
