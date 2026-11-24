import { Effect, FileSystem, Option, Path } from "effect";

import { resolveUnderWorkdir } from "../../../command-internal/glob.ts";
import {
  ERR_MISSING_LOCAL,
  ERR_MISSING_REMOTE,
  findPendingMigrations,
} from "../../../command-internal/migration-pending.ts";
import { sqlFilesGlob } from "../../../command-internal/sql-files-glob.ts";
import { CliConfigKeys } from "../../../config/cli-config-keys.ts";
import { CliConfigValues } from "../../../config/cli-config-values.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { SparkBackendError, SparkMigrationRefusedError } from "./spark-project.ts";
import { attributeDryRunStatuses } from "./spark-schema-files.ts";
import { localMigrations, projectPaths, reportRefusals } from "./spark.shared.ts";
import { SparkTarget } from "./spark-target.ts";

interface PendingMigration {
  readonly file: string;
  readonly version: string;
  readonly name: string;
  readonly query: string;
}

/**
 * The pending files of `supabase/migrations` for the {@link SparkTarget}, after one dry run of
 * all of them: a refusal names its file and line, and fails before anything is applied.
 */
export const planPendingMigrations = Effect.fn("Spark.planPendingMigrations")(function* () {
  const spark = yield* SparkTarget;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* projectPaths();
  const local = yield* localMigrations(paths.migrations);
  const firstOfVersion = new Map<string, string>();
  for (const m of local) {
    const first = firstOfVersion.get(m.version);
    if (first !== undefined)
      return yield* new SparkBackendError({
        message: `Duplicate migration version ${m.version}: ${first} and ${m.file}`,
      });
    firstOfVersion.set(m.version, m.file);
  }
  const remote = (yield* spark.listMigrations).map((m) => m.version).toSorted();
  const reconciled = findPendingMigrations(
    local.map((m) => m.file),
    remote,
  );
  if (reconciled.kind === "missing-local")
    return yield* new SparkBackendError({
      message: `${ERR_MISSING_LOCAL} Versions: ${reconciled.versions.join(", ")}`,
    });
  // A file older than an applied migration would run after it here and before it on a reset.
  if (reconciled.kind === "missing-remote")
    return yield* new SparkBackendError({
      message: `${ERR_MISSING_REMOTE} Files: ${reconciled.paths.join(", ")}`,
    });
  const pendingFiles = new Set(reconciled.pending);
  const pending = local.filter((m) => pendingFiles.has(m.file));
  yield* Effect.annotateCurrentSpan({ "spark.migrations.pending": pending.length });
  if (pending.length === 0) return [] satisfies ReadonlyArray<PendingMigration>;
  const files = yield* Effect.forEach(pending, (migration) =>
    Effect.map(fs.readFileString(path.join(paths.migrations, migration.file)), (query) => ({
      ...migration,
      query,
    })),
  );
  const statuses = yield* spark.dryRunMigration({
    query: files.map((m) => m.query).join("\n;\n"),
    name: "pending",
  });
  const { refused, silent } = yield* attributeDryRunStatuses(statuses, files);
  if (refused.length > 0) {
    for (const [file, items] of Map.groupBy(refused, (r) => r.file))
      yield* reportRefusals(
        file ?? "the pending migrations",
        // Spark numbers lines across all pending files joined; the file's own line replaces it.
        items.map((r) => ({
          status: { ...r.status, line: r.line ?? null },
          at:
            r.file === undefined || r.line === undefined
              ? undefined
              : `supabase/migrations/${r.file}:${r.line}`,
        })),
      );
    return yield* new SparkMigrationRefusedError({
      message: `Spark refuses ${refused.length} statement(s) of the pending migrations; nothing was pushed`,
    });
  }
  if (silent[0] !== undefined)
    return yield* new SparkMigrationRefusedError({
      message: `Spark recorded nothing for ${silent[0]}: it contains no statement Spark runs`,
    });
  return files satisfies ReadonlyArray<PendingMigration>;
});

/** Applies planned migrations in order, each under its own version. */
export const applyMigrations = Effect.fn("Spark.applyMigrations")(function* (
  files: ReadonlyArray<PendingMigration>,
) {
  const spark = yield* SparkTarget;
  const output = yield* Output;
  for (const migration of files) {
    yield* output.raw(`Applying migration ${migration.file}...\n`, "stderr");
    const recorded = yield* spark.applyMigration({
      query: migration.query,
      name: migration.name,
      version: migration.version,
    });
    if (recorded === null)
      return yield* new SparkMigrationRefusedError({
        message: `Spark recorded nothing for ${migration.file}: it contains no statement Spark runs`,
      });
  }
});

/** Plans and applies the pending migrations, with no confirmation (`start`, `db reset`). */
export const applyPendingMigrations = planPendingMigrations().pipe(Effect.tap(applyMigrations));

/**
 * Runs the `[db.seed] sql_paths` files through the {@link SparkTarget}'s query route, each file
 * as one script. Spark keeps no seed history, so callers run them only on an empty database.
 */
export const runSeedFiles = Effect.fn("Spark.runSeedFiles")(function* () {
  const spark = yield* SparkTarget;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* Output;
  const settings = yield* CommandSettings;
  const configValues = yield* CliConfigValues;
  const workdir = path.resolve(settings.workdir);
  const configFailure = (cause: { readonly message: string }) =>
    new SparkBackendError({ message: cause.message, cause });
  const resolved = yield* configValues
    .load({ workdir, projectRef: Option.none() })
    .pipe(Effect.mapError(configFailure));
  const enabled = yield* resolved
    .get(CliConfigKeys.db.seed.enabled)
    .pipe(Effect.mapError(configFailure));
  if (!enabled.value) return [];
  const patterns = yield* resolved
    .get(CliConfigKeys.db.seed.sqlPaths)
    .pipe(Effect.mapError(configFailure));
  const { files, warnings } = yield* sqlFilesGlob(fs, path, patterns.value, workdir);
  if (warnings.length > 0) yield* output.raw(`WARN: ${warnings.join("\n")}\n`, "stderr");
  for (const file of files) {
    yield* output.raw(`Seeding data from ${file}...\n`, "stderr");
    const sql = yield* fs.readFileString(resolveUnderWorkdir(path, workdir, file));
    yield* spark.runQuery(sql, false);
  }
  yield* Effect.annotateCurrentSpan({ "spark.seed.files": files.length });
  return files;
});
