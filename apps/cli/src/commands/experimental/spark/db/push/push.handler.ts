import { Effect, FileSystem, Path } from "effect";

import { requireTargetMutationConsent } from "../../../../../command-internal/hosted-consent/hosted-consent.ts";
import {
  ERR_MISSING_LOCAL,
  ERR_MISSING_REMOTE,
  findPendingMigrations,
} from "../../../../../command-internal/migration-pending.ts";
import type { TargetFlagValues } from "../../../../../command-internal/target/target-flags.ts";
import { Output } from "../../../../../shared/output/output.service.ts";
import { SparkBackendError, SparkMigrationRefusedError } from "../../spark-project.ts";
import { attributeDryRunStatuses } from "../../spark-schema-files.ts";
import { localMigrations, projectPaths, reportRefusals } from "../../spark.shared.ts";
import { SparkTarget, withSparkTarget } from "../../spark-target.ts";

/** `supabase db push`: the pending migrations are dry-run together on Spark, then applied in order. */
export const sparkDbPush = Effect.fn("spark.db.push")(function* (flags: TargetFlagValues) {
  yield* withSparkTarget(flags, (target) =>
    Effect.gen(function* () {
      const spark = yield* SparkTarget;
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
      if (pending.length === 0) return yield* output.raw("Remote database is up to date.\n");
      const files = yield* Effect.forEach(pending, (migration) =>
        Effect.map(fs.readFileString(path.join(paths.migrations, migration.file)), (query) => ({
          ...migration,
          query,
        })),
      );
      // One dry run of all pending files, so nothing is applied when a later file is refused.
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
      yield* requireTargetMutationConsent(target, {
        action: "Push migrations",
        details: [`Apply these migrations:\n${files.map((m) => ` • ${m.file}`).join("\n")}`],
      });
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
      yield* output.raw("Finished supabase db push.\n");
    }),
  );
});
