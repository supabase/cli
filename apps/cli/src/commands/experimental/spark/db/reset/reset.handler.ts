import { Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { CliConfigKeys } from "../../../../../config/cli-config-keys.ts";
import { CliConfigValues } from "../../../../../config/cli-config-values.service.ts";
import { CommandSettings } from "../../../../../config/command-settings.service.ts";
import { Output } from "../../../../../shared/output/output.service.ts";
import { withChildTraceEnv, withProcessSpan } from "../../../../../shared/telemetry/spans.ts";
import { TelemetryState } from "../../../../../telemetry/telemetry-state.service.ts";
import { applyPendingMigrations, runSeedFiles } from "../../spark-apply.ts";
import {
  requireReadyDevInstanceState,
  SparkDevInstanceError,
  SparkDevInstanceMode,
  withDevInstanceLock,
  writeDevInstanceState,
} from "../../spark-dev-instance.ts";
import { SparkBackendError } from "../../spark-project.ts";
import { SparkStack } from "../../spark-stack.ts";
import { SparkTarget, withDevInstanceTarget } from "../../spark-target.ts";
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

const RESET_TIMEOUT_SECONDS = 60;

/**
 * The dev instance's reset: Spark empties it, then the migrations and seed files run again. The
 * state file records the seed as not run once the database is empty, until the seed succeeds, so
 * a failed reset seeds on `start`; a reset the API rejects leaves the database and the marker as
 * they were. The remote reset and the marker's clearing are one uninterruptible step, and a reset
 * whose outcome is unknown (an interrupt or no answer within a minute) clears the marker too, so
 * the next `start` seeds or fails loudly instead of skipping the seed on an empty database.
 */
const resetDevInstance = withDevInstanceLock(
  Effect.gen(function* () {
    const state = yield* requireReadyDevInstanceState();
    yield* withDevInstanceTarget(
      Effect.gen(function* () {
        const spark = yield* SparkTarget;
        const clearMarker = writeDevInstanceState({ ...state, seeded: false });
        yield* Effect.uninterruptibleMask((restore) =>
          restore(
            spark.resetDatabase.pipe(
              Effect.withSpan("spark.db.reset.remote"),
              Effect.timeoutOrElse({
                duration: `${RESET_TIMEOUT_SECONDS} seconds`,
                orElse: () =>
                  Effect.andThen(
                    clearMarker,
                    new SparkDevInstanceError({
                      reason: "timeout",
                      message: `Resetting the dev instance ${state.ref} got no answer within ${RESET_TIMEOUT_SECONDS} seconds, so it may or may not have been emptied. Run \`supabase db reset\` again.`,
                    }),
                  ),
              }),
              Effect.onInterrupt(() => Effect.ignore(clearMarker)),
            ),
          ).pipe(Effect.andThen(clearMarker)),
        );
        yield* applyPendingMigrations;
        yield* runSeedFiles();
      }),
    );
    yield* writeDevInstanceState({ ...state, seeded: true });
  }),
);

/** `supabase db reset`: rebuilds the Spark database from migrations and seed files. */
export const sparkDbReset = Effect.gen(function* () {
  const output = yield* Output;
  const telemetryState = yield* TelemetryState;
  if (yield* SparkDevInstanceMode)
    return yield* resetDevInstance.pipe(
      Effect.andThen(output.raw("Finished supabase db reset.\n")),
      Effect.ensuring(telemetryState.flush),
    );
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
