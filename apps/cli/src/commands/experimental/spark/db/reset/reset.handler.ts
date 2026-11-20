import { Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { CliConfigKeys } from "../../../../../config/cli-config-keys.ts";
import { CliConfigValues } from "../../../../../config/cli-config-values.service.ts";
import { CommandSettings } from "../../../../../config/command-settings.service.ts";
import { Output } from "../../../../../shared/output/output.service.ts";
import { withChildTraceEnv, withProcessSpan } from "../../../../../shared/telemetry/spans.ts";
import { TelemetryState } from "../../../../../telemetry/telemetry-state.service.ts";
import { SparkBackendError } from "../../spark-project.ts";
import { SparkStack } from "../../spark-stack.ts";
import { projectPaths } from "../../spark.shared.ts";

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
