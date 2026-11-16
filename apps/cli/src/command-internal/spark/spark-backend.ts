import { spawn as spawnDetached } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Config, Data, Effect, FileSystem, Path, Schedule, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import { withChildTraceEnv, withProcessSpan } from "../../shared/telemetry/spans.ts";

/** A failure of the experimental Spark backend, rendered as its message. */
export class SparkBackendError extends Data.TaggedError("SparkBackendError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/** A command the experimental Spark backend does not implement. */
export class SparkUnsupportedError extends Data.TaggedError("SparkUnsupportedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

const fail = (message: string) => Effect.fail(new SparkBackendError({ message }));

/** Host settings of the Spark backend; every value has an environment override. */
export const SparkSettings = Config.all({
  sparkBin: Config.String("SUPABASE_SPARK_BIN").pipe(Config.withDefault("spark")),
  bunBin: Config.String("SUPABASE_SPARK_BUN").pipe(Config.withDefault("bun")),
  pgDeltaDir: Config.String("SUPABASE_PG_DELTA_DIR").pipe(
    Config.withDefault(
      fileURLToPath(new URL("../../../../../../pg-toolbelt/packages/pg-delta", import.meta.url)),
    ),
  ),
  studioImage: Config.String("SUPABASE_SPARK_STUDIO_IMAGE").pipe(
    Config.withDefault("supabase/studio:latest"),
  ),
  noStudio: Config.Boolean("SUPABASE_SPARK_NO_STUDIO").pipe(Config.withDefault(false)),
  apiPort: Config.Port("SUPABASE_SPARK_API_PORT").pipe(Config.withDefault(54321)),
  studioPort: Config.Port("SUPABASE_SPARK_STUDIO_PORT").pipe(Config.withDefault(54323)),
  sparkPort: Config.Port("SUPABASE_SPARK_PORT").pipe(Config.withDefault(54331)),
});

export type SparkSettings = Config.Success<typeof SparkSettings>;

/** The vendored meta gateway (pg-meta, Studio SQL and Management API subset from Spark's description). */
export const gatewayScript = fileURLToPath(
  new URL("../../experimental/spark-gateway/gateway.ts", import.meta.url),
);

export const SparkKeys = Schema.Struct({
  anon: Schema.String,
  service: Schema.String,
  jwt: Schema.String,
});
export interface SparkKeys extends Schema.Schema.Type<typeof SparkKeys> {}

export const SparkState = Schema.Struct({
  keys: SparkKeys,
  sparkPid: Schema.Number,
  gatewayPid: Schema.Number,
  studioContainer: Schema.NullOr(Schema.String),
  apiPort: Schema.Number,
  studioPort: Schema.Number,
  sparkPort: Schema.Number,
});
export interface SparkState extends Schema.Schema.Type<typeof SparkState> {}

/** Project paths the Spark backend reads and writes. */
export const sparkPaths = (path: Path.Path, workdir: string) => {
  const root = path.resolve(workdir);
  const dir = path.join(root, "supabase", ".spark");
  return {
    root,
    dir,
    marker: path.join(dir, "backend"),
    state: path.join(dir, "state.json"),
    log: (name: string) => path.join(dir, `${name}.log`),
    gaps: path.join(dir, "gaps.jsonl"),
    migrations: path.join(root, "supabase", "migrations"),
    schemas: path.join(root, "supabase", "schemas"),
    snippets: path.join(root, "supabase", "snippets"),
  };
};
export type SparkPaths = ReturnType<typeof sparkPaths>;

/** True when the project opted into the Spark backend (`supabase start --experimental-spark`). */
export const isSparkProject = Effect.fn("Spark.isSparkProject")(function* (workdir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.exists(sparkPaths(path, workdir).marker).pipe(Effect.orElseSucceed(() => false));
});

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(SparkState));

export const readState = Effect.fn("Spark.readState")(function* (paths: SparkPaths) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(paths.state).pipe(Effect.option);
  if (text._tag === "None") return undefined;
  return yield* decodeState(text.value).pipe(Effect.orElseSucceed(() => undefined));
});

export const writeState = Effect.fn("Spark.writeState")(function* (
  paths: SparkPaths,
  state: SparkState,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(paths.state, `${JSON.stringify(state, null, 2)}\n`);
});

export const isAlive = (pid: number) =>
  Effect.sync(() => {
    if (pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

/** Starts a host process that outlives the CLI, with stdout and stderr appended to `logFile`. */
export const launchDaemon = Effect.fn("Spark.launchDaemon")(function* (
  name: string,
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Record<string, string>; readonly logFile: string },
) {
  yield* Effect.annotateCurrentSpan({ "spark.daemon": name, "process.executable": command });
  const pid = yield* Effect.try({
    try: () => {
      const out = openSync(options.logFile, "a");
      // `env` adds the daemon's variables to the inherited environment.
      const assignments = Object.entries(options.env).map(([k, v]) => `${k}=${v}`);
      const child = spawnDetached("env", [...assignments, command, ...args], {
        cwd: options.cwd,
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.unref();
      closeSync(out);
      return child.pid ?? 0;
    },
    catch: (cause) =>
      new SparkBackendError({ message: `cannot start ${name} (${command}): ${String(cause)}` }),
  });
  if (pid === 0) return yield* fail(`cannot start ${name}: ${command} was not found`);
  return pid;
});

/** Sends SIGINT, then SIGKILL when the process outlives a grace period. */
export const stopDaemon = Effect.fn("Spark.stopDaemon")(function* (pid: number) {
  if (!(yield* isAlive(pid))) return;
  yield* Effect.sync(() => process.kill(pid, "SIGINT"));
  const exited = yield* isAlive(pid).pipe(
    Effect.repeat({ until: (alive) => !alive, schedule: Schedule.spaced("100 millis") }),
    Effect.timeout("5 seconds"),
    Effect.option,
  );
  if (exited._tag === "None") yield* Effect.sync(() => process.kill(pid, "SIGKILL"));
});

/** Polls `check` until it returns true, failing with `what` after `timeout`. */
export const waitUntil = <E, R>(
  what: string,
  check: Effect.Effect<boolean, E, R>,
  timeout: "60 seconds" | "120 seconds" = "60 seconds",
) =>
  check.pipe(
    Effect.orElseSucceed(() => false),
    Effect.repeat({ until: (ok) => ok, schedule: Schedule.spaced("300 millis") }),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => fail(`timed out waiting for ${what}`),
    }),
    Effect.asVoid,
    Effect.withSpan("Spark.waitUntil", { attributes: { "spark.wait": what } }),
  );

export interface CapturedRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command to completion and captures its output. */
export const runCaptured = (
  spanName: string,
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
) =>
  withProcessSpan(
    spanName,
    { executable: command, argCount: args.length },
    (traceEnv) =>
      Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawner.spawn(
            ChildProcess.make(
              command,
              args,
              withChildTraceEnv(
                {
                  cwd: options.cwd,
                  env: options.env,
                  extendEnv: true,
                  stdin: "ignore",
                  stdout: "pipe",
                  stderr: "pipe",
                },
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
          return { code: Number(code), stdout, stderr } satisfies CapturedRun;
        }),
      ),
    (result) => result.code,
  ).pipe(
    Effect.mapError(
      (cause) => new SparkBackendError({ message: `${command} failed to run: ${cause.message}` }),
    ),
  );

export interface HttpResult {
  readonly status: number;
  readonly text: string;
}

/** One HTTP call to Spark or the gateway; transport failures map to `SparkBackendError`. */
export const sparkHttp = Effect.fn("Spark.http")(
  function* (
    method: "GET" | "POST",
    url: string,
    options: { readonly headers?: Record<string, string>; readonly body?: string } = {},
  ) {
    const client = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.make(method)(url).pipe(
      HttpClientRequest.setHeaders(options.headers ?? {}),
    );
    if (options.body !== undefined) {
      request = HttpClientRequest.bodyText(request, options.body, "application/json");
    }
    const response = yield* client.execute(request);
    const text = yield* response.text;
    yield* Effect.annotateCurrentSpan({ "http.status_code": response.status });
    return { status: response.status, text } satisfies HttpResult;
  },
  Effect.mapError(
    (cause) => new SparkBackendError({ message: `HTTP request failed: ${cause.message}` }),
  ),
  Effect.provide(FetchHttpClient.layer),
);

/** True when something answers HTTP at `url`. */
export const answers = (url: string) =>
  sparkHttp("GET", url).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
