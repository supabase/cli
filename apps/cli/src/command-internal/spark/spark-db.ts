import { DateTime, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { CliConfigKeys } from "../../config/cli-config-keys.ts";
import { CliConfigValues } from "../../config/cli-config-values.service.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { pgDeltaNextAdapterLayer } from "../../commands/db/shared/pgdelta-next-adapter.layer.ts";
import {
  PgDeltaNextAdapter,
  type PgDeltaNextSparkConnection,
} from "../../commands/db/shared/pgdelta-next-adapter.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import { withChildTraceEnv, withProcessSpan } from "../../shared/telemetry/spans.ts";
import { stackApiLayer } from "../stack-api.ts";
import { SparkBackendError, sparkUnsupported } from "./spark-project.ts";
import { SparkStack, sparkStackLayer } from "./spark-stack.ts";

const fail = (message: string, cause?: unknown) =>
  new SparkBackendError({ message, ...(cause === undefined ? {} : { cause }) });

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

const runningConnection = () => SparkStack.use((stack) => stack.connection);

/** Declarative files under `supabase/schemas`, named by their path inside it. */
const schemaFiles = Effect.fn("Spark.schemaFiles")(function* (schemas: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(schemas)))
    return yield* fail("no supabase/schemas directory: run `supabase db pull` first");
  const entries = yield* fs.readDirectory(schemas, { recursive: true });
  const names = entries.filter((name) => name.endsWith(".sql")).sort();
  const files = yield* Effect.forEach(names, (name) =>
    fs
      .readFileString(path.join(schemas, name))
      .pipe(Effect.map((sql) => ({ name: name.split(path.sep).join("/"), sql }))),
  );
  yield* Effect.annotateCurrentSpan({ "spark.schema_files": files.length });
  return files;
});

const migrationVersion = Effect.map(DateTime.now, (now) =>
  DateTime.formatIso(now).replace(/\D/gu, "").slice(0, 14),
);

/** What the Spark db commands need beyond the command runtime. */
export const sparkCommandLayer = Layer.mergeAll(
  sparkStackLayer.pipe(Layer.provide(stackApiLayer)),
  pgDeltaNextAdapterLayer,
).pipe(Layer.provideMerge(FetchHttpClient.layer));

/** `supabase db diff`: pg-delta plans `supabase/schemas` against Spark and proves it on scratch. */
export const sparkDbDiff = Effect.fn("spark.db.diff")(function* (file: string | undefined) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* Output;
  const pgDelta = yield* PgDeltaNextAdapter;
  const paths = yield* projectPaths();
  const connection = yield* runningConnection();
  const files = yield* schemaFiles(paths.schemas);
  const result = yield* pgDelta.planSparkSchema({ connection, files });
  for (const diagnostic of result.diagnostics)
    yield* output.raw(`schema files: ${diagnostic.severity}: ${diagnostic.message}\n`, "stderr");
  const proof = result.proof;
  if (proof !== undefined) {
    for (const diagnostic of proof.diagnostics)
      yield* output.raw(`proof: ${diagnostic.severity}: ${diagnostic.message}\n`, "stderr");
    yield* output.raw(
      proof.ok
        ? `Proof: OK (plan converges to the desired schema, ${proof.expected})\n`
        : `Proof: FAILED (expected ${proof.expected}, replay produced ${proof.actual})\n`,
      "stderr",
    );
  }
  if (result.diagnostics.some((d) => d.severity === "error"))
    return yield* fail("the schema files contain statements Spark cannot run");
  if (proof !== undefined && !proof.ok)
    return yield* fail("the plan does not converge to the schema files on Spark");
  if (result.sql === "") return yield* output.raw("No schema changes found\n");
  if (file === undefined) return yield* output.raw(result.sql);
  const name = `${yield* migrationVersion}_${file}.sql`;
  yield* fs.makeDirectory(paths.migrations, { recursive: true });
  yield* fs.writeFileString(path.join(paths.migrations, name), result.sql);
  yield* output.raw(`Created new migration at supabase/migrations/${name}\n`);
});

/** `supabase db pull`: pg-delta exports Spark's schema to `supabase/schemas`. */
export const sparkDbPull = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* Output;
  const pgDelta = yield* PgDeltaNextAdapter;
  const paths = yield* projectPaths();
  const connection = yield* runningConnection();
  const files = yield* pgDelta.exportSparkSchema(connection);
  yield* Effect.forEach(files, (exported) =>
    Effect.gen(function* () {
      const target = path.join(paths.schemas, exported.name);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, exported.sql);
    }),
  );
  yield* output.raw(`Exported ${files.length} file(s) to ${paths.schemas}\n`, "stderr");
  yield* output.raw("Finished supabase db pull.\n");
}).pipe(Effect.withSpan("spark.db.pull"));

const MigrationList = Schema.Array(Schema.Struct({ version: Schema.String }));
const DryRun = Schema.Struct({
  ok: Schema.optionalKey(Schema.Boolean),
  message: Schema.optionalKey(Schema.String),
  statuses: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        line: Schema.Finite,
        status: Schema.String,
        message: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const sparkRequest = Effect.fn("Spark.adminRequest")(function* <A>(
  connection: PgDeltaNextSparkConnection,
  schema: Schema.Codec<A, unknown>,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
) {
  const client = yield* HttpClient.HttpClient;
  const base = HttpClientRequest.make(method)(`${connection.url}${route}`).pipe(
    HttpClientRequest.setHeaders({ apikey: connection.key }),
  );
  const response = yield* client
    .execute(body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, body))
    .pipe(Effect.mapError((cause) => fail(`Spark request failed: ${cause.message}`, cause)));
  const text = yield* response.text.pipe(
    Effect.mapError((cause) => fail(`Spark request failed: ${cause.message}`, cause)),
  );
  yield* Effect.annotateCurrentSpan({ "http.status_code": response.status });
  const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError((cause) => fail(`unexpected Spark response for ${route}: ${text}`, cause)),
  );
  return { status: response.status, body: decoded };
});

/** `supabase db push`: dry-runs every pending migration on Spark, then applies them in order. */
export const sparkDbPush = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* Output;
  const paths = yield* projectPaths();
  const connection = yield* runningConnection();
  const files = (yield* fs.exists(paths.migrations))
    ? (yield* fs.readDirectory(paths.migrations)).filter((f) => /^\d+_.*\.sql$/u.test(f)).sort()
    : [];
  const applied = yield* sparkRequest(connection, MigrationList, "GET", "/_spark/v1/migrations");
  const done = new Set(applied.body.map(({ version }) => version));
  const pending = files.filter((f) => !done.has(f.split("_")[0] ?? ""));
  yield* Effect.annotateCurrentSpan({ "spark.migrations.pending": pending.length });
  if (pending.length === 0) return yield* output.raw("Remote database is up to date.\n");
  const migration = Effect.fnUntraced(function* (file: string) {
    const [version = "", ...rest] = file.replace(/\.sql$/u, "").split("_");
    const sql = yield* fs.readFileString(path.join(paths.migrations, file));
    return { version, name: rest.join("_"), sql };
  });
  for (const file of pending) {
    const dry = yield* sparkRequest(
      connection,
      DryRun,
      "POST",
      "/_spark/v1/migrations?dry_run=1",
      yield* migration(file),
    );
    for (const status of dry.body.statuses ?? [])
      if (status.status !== "ok")
        yield* output.raw(
          `${file}:${status.line}: ${status.status}${status.message === null || status.message === undefined ? "" : `: ${status.message}`}\n`,
          "stderr",
        );
    if (dry.status >= 400) return yield* fail(`${file}: ${dry.body.message ?? "rejected"}`);
    if (dry.body.ok !== true)
      return yield* fail(`${file} does not apply on Spark; nothing was pushed`);
  }
  for (const file of pending) {
    yield* output.raw(`Applying migration ${file}...\n`, "stderr");
    const applied = yield* sparkRequest(
      connection,
      DryRun,
      "POST",
      "/_spark/v1/migrations",
      yield* migration(file),
    );
    if (applied.status >= 400) return yield* fail(`${file}: ${applied.body.message ?? "rejected"}`);
  }
  yield* output.raw("Finished supabase db push.\n");
}).pipe(Effect.withSpan("spark.db.push"));

const sparkExecutable = Effect.fn("Spark.executable")(function* () {
  const settings = yield* CommandSettings;
  const configValues = yield* CliConfigValues;
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
  ).pipe(Effect.mapError((cause) => fail(`${executable} failed to run: ${cause.message}`, cause)));

/** `supabase db reset`: rebuilds Spark's database from migrations and seed files. */
export const sparkDbReset = Effect.gen(function* () {
  const output = yield* Output;
  const paths = yield* projectPaths();
  const executable = yield* sparkExecutable();
  const stack = yield* SparkStack;
  const reset = yield* stack.whileStopped(
    runSpark(executable, ["--workdir", paths.root, "db", "reset"]),
  );
  yield* output.raw(reset.output, "stderr");
  if (reset.code !== 0) return yield* fail("spark db reset failed");
  yield* output.raw("Finished supabase db reset.\n");
}).pipe(Effect.withSpan("spark.db.reset"));

/** `supabase gen types typescript --local`: types from Spark's schema description. */
export const sparkGenTypes = Effect.fn("spark.gen.types")(function* (
  lang: string,
  schemas: ReadonlyArray<string>,
) {
  const output = yield* Output;
  if (lang !== "typescript") return yield* sparkUnsupported(`gen types ${lang}`);
  const connection = yield* runningConnection();
  const client = yield* HttpClient.HttpClient;
  const query = schemas.length > 0 ? schemas.join(",") : "public";
  const response = yield* client
    .get(`${connection.url}/_dev/types/typescript?included_schemas=${encodeURIComponent(query)}`)
    .pipe(Effect.mapError((cause) => fail(cause.message, cause)));
  const text = yield* response.text.pipe(Effect.mapError((cause) => fail(cause.message, cause)));
  if (response.status !== 200) return yield* fail(`Spark returned no types: ${text}`);
  yield* output.raw(text);
});
