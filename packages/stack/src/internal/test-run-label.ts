import { Config, Effect, Option } from "effect";

/** Environment variable a test run sets so stack-created Docker/Podman resources can be labelled. */
export const testRunEnvVar = "SUPABASE_STACK_TEST_RUN";

/** Label key stamped on volumes and containers a test run creates. */
export const testRunLabelKey = "com.supabase.stack-test-run";

const testRunLabelPattern = /^[A-Za-z0-9-]{1,64}$/u;

/** Reads and validates the optional test-run id through Effect `Config`. */
export const readTestRunId: Effect.Effect<Option.Option<string>, string> = Effect.gen(function* () {
  const testRun = yield* Config.option(Config.string(testRunEnvVar)).pipe(
    Effect.mapError((cause) => String(cause)),
  );
  if (Option.isNone(testRun)) return testRun;
  if (!testRunLabelPattern.test(testRun.value))
    return yield* Effect.fail(
      `${testRunEnvVar} must match ${testRunLabelPattern.source}, got "${testRun.value}"`,
    );
  return testRun;
});

/** `--label` CLI args for the configured test-run id, empty when the env var is unset. */
export const testRunLabelArgs: Effect.Effect<ReadonlyArray<string>, string> = Effect.map(
  readTestRunId,
  (testRun) => (Option.isNone(testRun) ? [] : ["--label", `${testRunLabelKey}=${testRun.value}`]),
);
