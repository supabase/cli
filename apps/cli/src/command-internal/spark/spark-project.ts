import { Data, Effect, type FileSystem, type Path } from "effect";

import { CommandSettings } from "../../config/command-settings.service.ts";
import {
  readExperimentalFeatureConfig,
  resolveExperimentalFeature,
} from "../../shared/config/experimental-feature.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

/** A Spark project command could not reach or drive its local Spark stack. */
export class SparkBackendError extends Data.TaggedError("SparkBackendError")<{
  readonly message: string;
  readonly cause?: unknown;
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

/** Whether the project opted into Spark with `[experimental.spark] enabled`. */
const isSparkProject = Effect.fn("Spark.isSparkProject")(function* () {
  const settings = yield* CommandSettings;
  const enabled = yield* resolveExperimentalFeature({
    feature: "spark",
    configValue: readExperimentalFeatureConfig({
      feature: "spark",
      args: [],
      cwd: settings.workdir,
    }),
  }).pipe(Effect.orElseSucceed(() => false));
  yield* Effect.annotateCurrentSpan({ "spark.enabled": enabled });
  return enabled;
});

/** Runs `spark` for a Spark project and `postgres` otherwise. */
export const withSparkBackend = <A, E, R, A2, E2, R2>(
  postgres: Effect.Effect<A, E, R>,
  spark: Effect.Effect<A2, E2, R2>,
): Effect.Effect<A | A2, E | E2, R | R2 | CommandSettings | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    return (yield* isSparkProject()) ? yield* spark : yield* postgres;
  });

/** Fails a command the Spark backend does not implement. */
export const sparkUnsupported = (command: string) =>
  Effect.fail(
    new SparkUnsupportedError({
      message: `\`supabase ${command}\` is not supported on the experimental Spark backend (no Postgres runs locally).`,
    }),
  );
