import { Data, Effect, type FileSystem, type Path } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";
import { makeDir } from "../../../command-internal/make-dir.ts";
import {
  formatMigrationTimestamp,
  getMigrationPath,
} from "../../../command-internal/migration-file.ts";
import type { MigrationTransactionMode } from "../../../command-internal/migration-file.ts";

/** A migration file written by a diff/pull, paired with its history version. */
export interface WrittenMigration {
  readonly path: string;
  readonly version: string;
}

/**
 * A write failure from `writePgDeltaMigrations`. Callers map this to their
 * own command-domain write error (`DbDiffWriteError` / `DbPullWriteError`).
 */
export class PgDeltaMigrationWriteError extends Data.TaggedError("PgDeltaMigrationWriteError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * Bounds the base-timestamp bump retry so a directory already full of same-second
 * migrations can't spin forever.
 */
const MAX_VERSION_COLLISION_ATTEMPTS = 60;

/**
 * Writes one migration file per plan unit, giving multi-unit plans strictly increasing
 * timestamps so execution and history order stay stable. The full version set is
 * collision-checked against the migrations directory up front, advancing the base timestamp
 * forward only (never backdated) until unique. Each file opens with the exclusive `"wx"`
 * flag against overwrite races; a failed write removes every file this call already wrote.
 */
export const writePgDeltaMigrations = (
  fs: FileSystem.FileSystem,
  pathSvc: Path.Path,
  opts: {
    readonly workdir: string;
    readonly baseMillis: number;
    readonly name: string;
    readonly files: ReadonlyArray<{
      readonly name: string;
      readonly suffix?: string | null;
      readonly sql: string;
      readonly transactionMode: MigrationTransactionMode;
    }>;
  },
): Effect.Effect<Array<WrittenMigration>, PgDeltaMigrationWriteError> =>
  Effect.gen(function* () {
    const { workdir, name, files } = opts;
    for (const file of files) {
      if (file.transactionMode !== "transactional" && file.transactionMode !== "none") {
        return yield* Effect.fail(
          new PgDeltaMigrationWriteError({
            message: `unknown pg-delta transaction mode ${JSON.stringify(file.transactionMode)}`,
          }),
        );
      }
    }
    const single = files.length === 1;
    const migrationsDir = pathSvc.join(workdir, "supabase", "migrations");
    const migrationEntries = yield* fs.readDirectory(migrationsDir).pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed([] as ReadonlyArray<string>)
          : Effect.fail(
              new PgDeltaMigrationWriteError({
                message: `failed to read migration directory: ${error.message}`,
              }),
            ),
      ),
    );
    const usedVersions = new Set<string>();
    for (const entry of migrationEntries) {
      const match = /^([0-9]+)_(.+)$/u.exec(entry);
      if (match?.[1] === undefined) continue;
      if (entry.endsWith(".sql")) {
        usedVersions.add(match[1]);
        continue;
      }
      const stat = yield* fs.stat(pathSvc.join(migrationsDir, entry)).pipe(
        Effect.mapError(
          (cause) =>
            new PgDeltaMigrationWriteError({
              message: `failed to inspect migration directory entry: ${cause.message}`,
            }),
        ),
      );
      if (stat.type === "Directory") {
        // Nested names such as `snapshots/remote` are stored under a
        // `<version>_snapshots/` directory, whose prefix still owns the version.
        usedVersions.add(match[1]);
      }
    }
    const buildSet = (baseMillis: number): Array<WrittenMigration> =>
      files.map((file, i) => {
        const version = formatMigrationTimestamp(baseMillis + i * 1000);
        const unitName = single
          ? name
          : file.suffix !== undefined && file.suffix !== null
            ? `${name}${file.suffix}`
            : `${name}_${file.name}`;
        return { path: getMigrationPath(pathSvc, workdir, version, unitName), version };
      });

    let baseMillis = opts.baseMillis;
    let set = buildSet(baseMillis);
    for (let attempt = 0; ; attempt++) {
      let collision = set.some((w) => usedVersions.has(w.version));
      if (!collision) {
        for (const w of set) {
          const exists = yield* fs.exists(w.path).pipe(
            Effect.mapError(
              (cause) =>
                new PgDeltaMigrationWriteError({
                  message: `failed to check migration file: ${cause.message}`,
                }),
            ),
          );
          if (exists) {
            collision = true;
            break;
          }
        }
      }
      if (!collision) break;
      if (attempt + 1 >= MAX_VERSION_COLLISION_ATTEMPTS) {
        return yield* Effect.fail(
          new PgDeltaMigrationWriteError({
            message: `failed to find a unique migration version after ${MAX_VERSION_COLLISION_ATTEMPTS} attempts`,
          }),
        );
      }
      baseMillis += 1000;
      set = buildSet(baseMillis);
    }

    const written: Array<WrittenMigration> = [];
    const writeAll = Effect.gen(function* () {
      for (let i = 0; i < files.length; i++) {
        const w = set[i]!;
        const file = files[i]!;
        yield* makeDir(fs, pathSvc.dirname(w.path)).pipe(
          Effect.mapError((cause) => new PgDeltaMigrationWriteError({ message: cause.message })),
        );
        yield* fs.writeFileString(w.path, `${file.sql}\n`, { flag: "wx" }).pipe(
          Effect.mapError(
            (cause) =>
              new PgDeltaMigrationWriteError({
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
