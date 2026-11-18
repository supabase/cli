import { Data, Effect, type FileSystem, type Path } from "effect";

import { extractCommandPath, hasRootVersionFlag } from "../../shared/cli/run.ts";
import {
  type ExperimentalFeatureFlagError,
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

/** A Management API call of a Spark command failed or answered an unexpected status. */
export class SparkApiError extends Data.TaggedError("SparkApiError")<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.status === undefined ? actionability.externalNetwork : actionability.apiStatus;
  }
}

/** Spark refused statements of a migration in its dry run; each one is a Postgres compatibility gap. */
export class SparkMigrationRefusedError extends Data.TaggedError("SparkMigrationRefusedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/** The shadow Postgres a Spark `db diff` or `db pull` loads the project's dump into failed. */
export class SparkShadowError extends Data.TaggedError("SparkShadowError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

/**
 * Whether the invoked project opted into Spark with `[experimental.spark] enabled` (or
 * `SUPABASE_EXPERIMENTAL_SPARK_ENABLED`), read before parse so the root swaps in the Spark
 * command tree. `--version` never selects it.
 */
export const resolveSparkEnabled = (input: {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}): Effect.Effect<boolean, ExperimentalFeatureFlagError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const routingArgs =
      input.args[0] === "__complete" || input.args[0] === "__completeNoDesc"
        ? input.args.slice(0, -1)
        : input.args;
    if (hasRootVersionFlag(routingArgs) && extractCommandPath(routingArgs).length === 0)
      return false;
    return yield* resolveExperimentalFeature({
      feature: "spark",
      configValue: readExperimentalFeatureConfig({
        feature: "spark",
        ...input,
        args: routingArgs,
      }),
    });
  }).pipe(Effect.withSpan("Spark.resolveEnabled"));
