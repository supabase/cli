import { DateTime, Effect, FileSystem, Option, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { CliConfigKeys } from "../../config/cli-config-keys.ts";
import { CliConfigValues } from "../../config/cli-config-values.service.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../config/project-ref.service.ts";
import { writeProjectLink } from "../../shared/config/project-link.ts";
import { Output } from "../../shared/output/output.service.ts";
import { withChildTraceEnv, withProcessSpan } from "../../shared/telemetry/spans.ts";
import { LinkedProjectCache } from "../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import { renderGlamourTable } from "../../output/glamour-table.ts";
import { ERR_MISSING_LOCAL } from "../migration-pending.ts";
import { MIGRATE_FILE_PATTERN } from "../migration-history.ts";
import { sortMigrationVersions } from "../migration-timestamp.format.ts";
import {
  makeMigrationListRows,
  migrationListTableCells,
} from "../../commands/migration/list/list.format.ts";
import {
  filesForDeclarativeShadowLoad,
  prepareDeclarativeShadow,
} from "../../commands/db/shared/pgdelta-declarative-shadow-prep.ts";
import {
  LoadPgDeltaSqlFiles,
  ReadPgDeltaExportManifest,
} from "../../commands/db/shared/pgdelta-files.ts";
import { PgDeltaNextAdapter } from "../../commands/db/shared/pgdelta-next-adapter.service.ts";
import { reportPgDeltaNextDiagnostics } from "../../commands/db/shared/pgdelta-next-diagnostics.ts";
import { writeDeclarativeSchemas } from "../../commands/db/shared/pgdelta.write.ts";
import {
  applySparkMigration,
  dryRunSparkMigration,
  dumpSparkSchema,
  getSparkProject,
  isRefused,
  listSparkMigrations,
  sparkTypescriptTypes,
  type SparkDryRunStatus,
} from "./spark-api.ts";
import { SparkBackendError, SparkMigrationRefusedError } from "./spark-project.ts";
import {
  attributeDryRunStatuses,
  findDeclaration,
  withoutBaselineFiles,
} from "./spark-schema-files.ts";
import { acquireSparkShadows, loadSparkDump } from "./spark-shadow.ts";
import { SparkStack } from "./spark-stack.ts";

const projectPaths = Effect.fn("Spark.projectPaths")(function* () {
  const settings = yield* CommandSettings;
  const path = yield* Path.Path;
  const root = path.resolve(settings.workdir);
  return {
    root,
    migrations: path.join(root, "supabase", "migrations"),
    schemas: path.join(root, "supabase", "schemas"),
  };
});

/** Resolves the linked project and caches it for telemetry whether `body` succeeds or fails. */
const withLinkedProject = <A, E, R>(
  projectRef: Option.Option<string>,
  body: (ref: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const resolver = yield* ProjectRefResolver;
    const linkedProjectCache = yield* LinkedProjectCache;
    const telemetryState = yield* TelemetryState;
    const ref = yield* resolver.resolve(projectRef);
    return yield* body(ref).pipe(
      Effect.ensuring(linkedProjectCache.cache(ref)),
      Effect.ensuring(telemetryState.flush),
    );
  });

const reportRefusals = Effect.fnUntraced(function* (
  label: string,
  refused: ReadonlyArray<SparkDryRunStatus>,
  declaredIn: ReadonlyArray<{ readonly name: string; readonly sql: string }> = [],
) {
  const output = yield* Output;
  yield* output.raw(
    `Spark refuses ${refused.length} statement(s) of ${label}. Each one is a Postgres compatibility gap of Spark:\n`,
    "stderr",
  );
  for (const status of refused) {
    const line = status.line === undefined || status.line === null ? "" : ` (line ${status.line})`;
    const declared = findDeclaration(status.statement, declaredIn);
    if (declared !== undefined)
      yield* output.raw(`  supabase/schemas/${declared.file}:${declared.line}\n`, "stderr");
    yield* output.raw(
      `  ${status.status} ${status.kind}${line}: ${status.statement}\n${
        status.message === undefined || status.message === null ? "" : `    ${status.message}\n`
      }`,
      "stderr",
    );
  }
});

const migrationVersion = Effect.map(DateTime.now, (now) =>
  DateTime.formatIso(now).replace(/\D/gu, "").slice(0, 14),
);

/** `supabase db pull`: the project's dump, loaded into a shadow Postgres, exported to `supabase/schemas`. */
export const sparkDbPull = Effect.fn("spark.db.pull")(function* (flags: {
  readonly projectRef: Option.Option<string>;
  readonly schema: ReadonlyArray<string>;
}) {
  yield* withLinkedProject(flags.projectRef, (ref) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const output = yield* Output;
      const pgDelta = yield* PgDeltaNextAdapter;
      const paths = yield* projectPaths();
      const dump = yield* dumpSparkSchema(ref, flags.schema);
      const exported = yield* Effect.scoped(
        Effect.gen(function* () {
          const [pool, clean] = yield* acquireSparkShadows(2);
          if (pool === undefined || clean === undefined)
            return yield* Effect.die("no shadow database");
          yield* loadSparkDump(pool, dump);
          const full = yield* pgDelta.exportDeclarativeSchema({ pool, schema: flags.schema });
          // The image's own grants, default privileges and extensions are not in Spark.
          const baseline = yield* pgDelta.exportDeclarativeSchema({
            pool: clean,
            schema: flags.schema,
          });
          return withoutBaselineFiles(full, baseline);
        }),
      ).pipe(Effect.withSpan("spark.db.pull.export"));
      yield* reportPgDeltaNextDiagnostics("declarativeExport", exported.diagnostics, false, false);
      yield* writeDeclarativeSchemas(fs, path, paths.schemas, exported);
      yield* output.raw(
        `Exported ${exported.files.length} file(s) to ${paths.schemas}\n`,
        "stderr",
      );
      yield* output.raw("Finished supabase db pull.\n");
    }),
  );
});

/**
 * `supabase db diff`: plans `supabase/schemas` against the project's dump in a shadow Postgres
 * with pg-delta, then dry-runs the migration on Spark; a refused statement writes nothing.
 */
export const sparkDbDiff = Effect.fn("spark.db.diff")(function* (flags: {
  readonly projectRef: Option.Option<string>;
  readonly schema: ReadonlyArray<string>;
  readonly file: Option.Option<string>;
}) {
  yield* withLinkedProject(flags.projectRef, (ref) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const output = yield* Output;
      const pgDelta = yield* PgDeltaNextAdapter;
      const paths = yield* projectPaths();
      if (!(yield* fs.exists(paths.schemas)))
        return yield* new SparkBackendError({
          message: "no supabase/schemas directory: run `supabase db pull` first",
        });
      const files = yield* LoadPgDeltaSqlFiles(fs, path, paths.schemas);
      const manifest = yield* ReadPgDeltaExportManifest(fs, path, paths.schemas);
      const dump = yield* dumpSparkSchema(ref, flags.schema);
      const plan = yield* Effect.scoped(
        Effect.gen(function* () {
          const [target, desired] = yield* acquireSparkShadows(2);
          if (target === undefined || desired === undefined)
            return yield* Effect.die("no shadow database");
          yield* loadSparkDump(target, dump);
          const prep = yield* prepareDeclarativeShadow(desired, files);
          return yield* pgDelta.planDeclarativeSchema({
            targetPool: target,
            shadowPool: desired,
            files: filesForDeclarativeShadowLoad(files, prep.restorePgjwt),
            allowDrops: true,
            debug: false,
            schema: flags.schema,
            ...(manifest === undefined ? {} : { manifest }),
          });
        }),
      ).pipe(Effect.withSpan("spark.db.diff.plan"));
      yield* reportPgDeltaNextDiagnostics("declarativePlan", plan.diagnostics, false, false);
      yield* Effect.annotateCurrentSpan({ "diff.empty": !plan.changes });
      if (!plan.changes || plan.sql.trim() === "")
        return yield* output.raw("No schema changes found\n");

      const name = Option.getOrElse(flags.file, () => "db_diff");
      const statuses = yield* dryRunSparkMigration(ref, { query: plan.sql, name });
      const refused = statuses.filter(isRefused);
      if (refused.length > 0) {
        yield* reportRefusals("the generated migration", refused, files);
        return yield* new SparkMigrationRefusedError({
          message: `Spark refuses ${refused.length} statement(s) of the generated migration; no migration was written`,
        });
      }
      yield* output.raw(`Dry run on Spark: OK (${statuses.length} statement(s))\n`, "stderr");
      if (Option.isNone(flags.file)) return yield* output.raw(plan.sql);
      const file = `${yield* migrationVersion}_${flags.file.value}.sql`;
      yield* fs.makeDirectory(paths.migrations, { recursive: true });
      yield* fs.writeFileString(path.join(paths.migrations, file), plan.sql);
      yield* output.raw(`Created new migration at supabase/migrations/${file}\n`, "stderr");
    }),
  );
});

/** Local migration files in version order. */
const localMigrations = Effect.fn("Spark.localMigrations")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(directory))) return [];
  const found = (yield* fs.readDirectory(directory)).flatMap((file) => {
    const match = MIGRATE_FILE_PATTERN.exec(file);
    return match?.[1] === undefined ? [] : [{ file, version: match[1], name: match[2] ?? "" }];
  });
  const order = sortMigrationVersions(found.map((m) => m.version));
  return order.flatMap((version) => found.filter((m) => m.version === version));
});

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
      const { refused, silent } = attributeDryRunStatuses(
        yield* dryRunSparkMigration(ref, {
          query: files.map((m) => m.query).join("\n;\n"),
          name: "pending",
        }),
        files,
      );
      if (refused.length > 0) {
        for (const [file, items] of Map.groupBy(refused, (r) => r.file))
          yield* reportRefusals(
            file ?? "the pending migrations",
            items.map((r) => r.status),
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

/** `supabase migration list`: local migration files against the project's migration history. */
export const sparkMigrationList = Effect.fn("spark.migration.list")(function* (flags: {
  readonly projectRef: Option.Option<string>;
}) {
  yield* withLinkedProject(flags.projectRef, (ref) =>
    Effect.gen(function* () {
      const output = yield* Output;
      const paths = yield* projectPaths();
      const local = (yield* localMigrations(paths.migrations)).map((m) => m.version);
      const remote = sortMigrationVersions((yield* listSparkMigrations(ref)).map((m) => m.version));
      const rows = makeMigrationListRows(remote, local);
      if (output.format === "json" || output.format === "stream-json")
        return yield* output.success("", { migrations: rows });
      yield* output.raw(
        renderGlamourTable(["Local", "Remote", "Time (UTC)"], migrationListTableCells(rows)),
      );
    }),
  );
});

/** `supabase gen types typescript`: the project's TypeScript types, on stdout. */
export const sparkGenTypes = Effect.fn("spark.gen.types")(function* (flags: {
  readonly projectRef: Option.Option<string>;
  readonly schema: ReadonlyArray<string>;
}) {
  yield* withLinkedProject(flags.projectRef, (ref) =>
    Effect.gen(function* () {
      const output = yield* Output;
      yield* output.raw(yield* sparkTypescriptTypes(ref, flags.schema));
    }),
  );
});

/** `supabase link`: checks the project exists, then records it in `supabase/.link.json`. */
export const sparkLink = Effect.fn("spark.link")(function* (flags: {
  readonly projectRef: Option.Option<string>;
}) {
  const resolver = yield* ProjectRefResolver;
  const settings = yield* CommandSettings;
  const output = yield* Output;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const ref = yield* resolver.resolveForLink(flags.projectRef);
  yield* Effect.gen(function* () {
    const project = yield* getSparkProject(ref);
    yield* writeProjectLink(settings.workdir, {
      project: {
        ref,
        ...(project.name === undefined ? {} : { name: project.name }),
        ...(project.organization_id === undefined
          ? {}
          : { organization_id: project.organization_id }),
        ...(project.organization_slug === undefined
          ? {}
          : { organization_slug: project.organization_slug }),
      },
      active_branch: { ref, ...(project.name === undefined ? {} : { name: project.name }) },
      fetchedAt: DateTime.formatIso(yield* DateTime.now),
    });
    yield* output.raw("Finished supabase link.\n");
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});

const sparkExecutable = Effect.fn("Spark.executable")(function* () {
  const settings = yield* CommandSettings;
  const configValues = yield* CliConfigValues;
  const fail = (message: string, cause?: unknown) =>
    new SparkBackendError({ message, ...(cause === undefined ? {} : { cause }) });
  const resolved = yield* configValues
    .load({ workdir: settings.workdir, projectRef: Option.none() })
    .pipe(Effect.mapError((cause) => fail(cause.message, cause)));
  const { value } = yield* resolved
    .get(CliConfigKeys.experimental.spark.executable)
    .pipe(Effect.mapError((cause) => fail(cause.message, cause)));
  const executable = Option.getOrUndefined(value);
  if (executable === undefined || executable === "")
    return yield* fail(
      "experimental.spark.executable must name the spark binary (or set SUPABASE_EXPERIMENTAL_SPARK_EXECUTABLE)",
    );
  return executable;
});

const runSpark = (executable: string, args: ReadonlyArray<string>) =>
  withProcessSpan(
    "spark.db.reset.run",
    { executable, argCount: args.length },
    (traceEnv) =>
      Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawner.spawn(
            ChildProcess.make(
              executable,
              args,
              withChildTraceEnv(
                { extendEnv: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
                traceEnv,
              ),
            ),
          );
          const [stdout, stderr, code] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(child.stdout)),
              Stream.mkString(Stream.decodeText(child.stderr)),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          return { code: Number(code), output: stdout + stderr };
        }),
      ),
    (result) => result.code,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SparkBackendError({ message: `${executable} failed to run: ${cause.message}`, cause }),
    ),
  );

/** `supabase db reset`: rebuilds the local Spark stack's database from migrations and seed files. */
export const sparkDbReset = Effect.gen(function* () {
  const output = yield* Output;
  const telemetryState = yield* TelemetryState;
  yield* Effect.gen(function* () {
    const paths = yield* projectPaths();
    const executable = yield* sparkExecutable();
    const stack = yield* SparkStack;
    const reset = yield* stack.whileStopped(
      runSpark(executable, ["--workdir", paths.root, "db", "reset"]),
    );
    yield* output.raw(reset.output, "stderr");
    if (reset.code !== 0) return yield* new SparkBackendError({ message: "spark db reset failed" });
    yield* output.raw("Finished supabase db reset.\n");
  }).pipe(Effect.ensuring(telemetryState.flush));
}).pipe(Effect.withSpan("spark.db.reset"));
