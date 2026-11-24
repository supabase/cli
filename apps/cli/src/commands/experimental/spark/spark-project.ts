import { Data, Effect, type FileSystem, Path, Predicate } from "effect";

import { CliConfigKeys } from "../../../config/cli-config-keys.ts";
import { extractCommandPath, hasRootVersionFlag } from "../../../shared/cli/run.ts";
import {
  ExperimentalFeatureFlagError,
  readExperimentalFeatureConfig,
  readProjectConfigDocument,
  resolveExperimentalFeature,
} from "../../../shared/config/experimental-feature.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/** A Spark command found the project's local files or migration history unusable. */
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
 * The project's `[experimental.spark] enabled`, `undefined` when it is absent or the config is
 * unreadable. A value that is not a literal boolean fails: the tree is chosen before `env(...)`
 * references resolve, so it would otherwise select the mainline tree.
 */
const readSparkEnabledConfig = (input: {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}): Effect.Effect<
  boolean | undefined,
  ExperimentalFeatureFlagError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const found = yield* readProjectConfigDocument(input).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (found === undefined) return undefined;
    const experimental = Predicate.isObject(found.document)
      ? found.document["experimental"]
      : undefined;
    const spark = Predicate.isObject(experimental) ? experimental["spark"] : undefined;
    if (!Predicate.isObject(spark) || !Object.hasOwn(spark, "enabled")) return undefined;
    const enabled = spark["enabled"];
    if (typeof enabled === "boolean") return enabled;
    const envName = CliConfigKeys.experimental.spark.enabled.env[0] ?? "";
    return yield* new ExperimentalFeatureFlagError({
      envName,
      message: `experimental.spark.enabled must be the literal true or false in supabase/${path.basename(found.configPath)}: the command tree is chosen before env(...) references are read. Write true or false, or remove the key and set ${envName} in the shell.`,
    });
  });

/**
 * Whether the invoked project opted into Spark with `[experimental.spark] enabled` (or
 * `SUPABASE_EXPERIMENTAL_SPARK_ENABLED`), read before parse so the root swaps in the Spark
 * command tree. `--version` never selects it. An `enabled` that is not a literal boolean fails
 * whatever selects the tree.
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
    const configValue = yield* readSparkEnabledConfig({ ...input, args: routingArgs });
    const enabled = yield* resolveExperimentalFeature({
      feature: "spark",
      configValue: Effect.succeed(configValue),
    });
    if (!enabled) return false;
    const stack = yield* resolveExperimentalFeature({
      feature: "stack",
      configValue: readExperimentalFeatureConfig({ ...input, feature: "stack", args: routingArgs }),
    });
    if (stack) {
      const stackEnv = CliConfigKeys.experimental.stack.env[0] ?? "";
      return yield* new ExperimentalFeatureFlagError({
        envName: stackEnv,
        message: `experimental.spark.enabled and experimental.stack cannot both be true: a Spark project has no local stack. Remove experimental.stack (or ${stackEnv}) from a Spark project.`,
      });
    }
    return true;
  }).pipe(Effect.withSpan("Spark.resolveEnabled"));
