import { Effect, FileSystem, Option, Path } from "effect";

import { ERR_MISSING_LOCAL } from "../../../../../command-internal/migration-pending.ts";
import { Output } from "../../../../../shared/output/output.service.ts";
import { applySparkMigration, dryRunSparkMigration, listSparkMigrations } from "../../spark-api.ts";
import { SparkBackendError, SparkMigrationRefusedError } from "../../spark-project.ts";
import { attributeDryRunStatuses } from "../../spark-schema-files.ts";
import {
  localMigrations,
  projectPaths,
  reportRefusals,
  withLinkedProject,
} from "../../spark.shared.ts";

/** `supabase db push`: the pending migrations are dry-run together on Spark, then applied in order. */
export const sparkDbPush = Effect.fn("spark.db.push")(function* (flags: {
  readonly projectRef: Option.Option<string>;
}) {
  yield* withLinkedProject(flags.projectRef, (ref) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const output = yield* Output;
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
      const remote = new Set((yield* listSparkMigrations(ref)).map((m) => m.version));
      const localVersions = new Set(local.map((m) => m.version));
      const remoteOnly = [...remote].filter((version) => !localVersions.has(version));
      if (remoteOnly.length > 0)
        return yield* new SparkBackendError({
          message: `${ERR_MISSING_LOCAL} Versions: ${remoteOnly.join(", ")}`,
        });
      const pending = local.filter((m) => !remote.has(m.version));
      yield* Effect.annotateCurrentSpan({ "spark.migrations.pending": pending.length });
      if (pending.length === 0) return yield* output.raw("Remote database is up to date.\n");
      const files = yield* Effect.forEach(pending, (migration) =>
        Effect.map(fs.readFileString(path.join(paths.migrations, migration.file)), (query) => ({
          ...migration,
          query,
        })),
      );
      // One dry run of all pending files, so nothing is applied when a later file is refused.
      const statuses = yield* dryRunSparkMigration(ref, {
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
      for (const migration of files) {
        yield* output.raw(`Applying migration ${migration.file}...\n`, "stderr");
        const recorded = yield* applySparkMigration(ref, {
          query: migration.query,
          name: migration.name,
          version: migration.version,
        });
        if (recorded === null)
          return yield* new SparkMigrationRefusedError({
            message: `Spark recorded nothing for ${migration.file}: it contains no statement Spark runs`,
          });
      }
      yield* output.raw("Finished supabase db push.\n");
    }),
  );
});
