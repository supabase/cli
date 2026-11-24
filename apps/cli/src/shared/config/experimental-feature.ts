import { CliConfigSchema, findCliProjectPaths } from "@supabase/config/effect";
import { cliConfigFormatForPath, parseCliConfigDocument } from "@supabase/config/internal";
import { Config, Data, Effect, FileSystem, Option, Path, Predicate, Result, Schema } from "effect";
import { type CliConfigSources, pickCliConfigKey } from "../../config/cli-config-key.ts";
import { CliConfigKeys } from "../../config/cli-config-keys.ts";
import { resolveWorkdir } from "../../config/command-settings.layer.ts";
import { rootFlagTokens } from "../cli/run.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

export class ExperimentalFeatureFlagError extends Data.TaggedError("ExperimentalFeatureFlagError")<{
  readonly envName: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

const featureSchemas = {
  stack: CliConfigSchema.fields.experimental.to.fields.stack,
  compute: CliConfigSchema.fields.experimental.to.fields.compute,
  spark: CliConfigSchema.fields.experimental.to.fields.spark,
} as const;

type ExperimentalFeature = keyof typeof featureSchemas;

/** The boolean inside a decoded feature value; `[experimental.spark]` is a table. */
const featureEnabled = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (Predicate.isObject(value) && "enabled" in value)
    return typeof value.enabled === "boolean" ? value.enabled : undefined;
  return undefined;
};

/**
 * Keys of a local Spark stack, which this CLI does not run: a config that sets one fails instead
 * of having it ignored like other unknown keys.
 */
const UNSUPPORTED_SPARK_KEYS = ["dev_instance", "executable", "studio_executable"] as const;

const firstExplicitLongFlagValue = (
  args: ReadonlyArray<string>,
  flagName: string,
): string | undefined => {
  for (const { token, index } of rootFlagTokens(args)) {
    if (token === `--${flagName}`) return args[index + 1];
    if (token.startsWith(`--${flagName}=`)) return token.slice(flagName.length + 3);
  }
  return undefined;
};

const readEnv = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
    Effect.map(Option.getOrUndefined),
  );

/** The project's parsed config document and its path, `undefined` when the project has none. */
const readConfigDocument = Effect.fnUntraced(function* (input: {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const explicitWorkdir = firstExplicitLongFlagValue(input.args, "workdir");
  const resolvedWorkdir = yield* resolveWorkdir(
    explicitWorkdir === undefined ? Option.none() : Option.some(explicitWorkdir),
    Option.fromNullishOr(yield* readEnv("SUPABASE_WORKDIR")),
    input.cwd,
    path,
  );
  const project = yield* findCliProjectPaths(resolvedWorkdir.workdir, { search: false });
  if (project === null) return undefined;
  const content = yield* fs.readFileString(project.configPath);
  const document = yield* Effect.try(() =>
    parseCliConfigDocument(content, cliConfigFormatForPath(project.configPath)),
  );
  return { document, configPath: project.configPath };
});

/** Reads one experimental feature, treating unavailable or invalid configuration as unset. */
export const readExperimentalFeatureConfig = (input: {
  readonly feature: ExperimentalFeature;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}): Effect.Effect<boolean | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const found = yield* readConfigDocument(input);
    if (found === undefined) return undefined;
    const schema = Schema.Struct({
      experimental: Schema.optionalKey(
        Schema.Struct({ [input.feature]: featureSchemas[input.feature] }),
      ),
    });
    const decoded = yield* Schema.decodeUnknownEffect(schema)(found.document);
    return featureEnabled(decoded.experimental?.[input.feature]);
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Fails when the project's `[experimental.spark]` sets a key of a local Spark stack, or an `enabled`
 * that is not a literal boolean: the tree is chosen before `env(...)` references resolve, so such
 * a value would otherwise select the mainline tree. An absent or unreadable config passes.
 */
export const rejectUnsupportedSparkConfig = (input: {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}): Effect.Effect<void, ExperimentalFeatureFlagError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const found = yield* readConfigDocument(input).pipe(Effect.orElseSucceed(() => undefined));
    if (found === undefined) return;
    const file = `supabase/${path.basename(found.configPath)}`;
    const envName = CliConfigKeys.experimental.spark.enabled.env[0] ?? "";
    const experimental = Predicate.isObject(found.document)
      ? found.document["experimental"]
      : undefined;
    const spark = Predicate.isObject(experimental) ? experimental["spark"] : undefined;
    if (!Predicate.isObject(spark)) return;
    const unsupported = UNSUPPORTED_SPARK_KEYS.find((key) => Object.hasOwn(spark, key));
    if (unsupported !== undefined)
      return yield* new ExperimentalFeatureFlagError({
        envName,
        message: `experimental.spark.${unsupported} does not exist: the Spark commands develop against a remote dev instance, and no local Spark process or Studio runs. Remove it from ${file}.`,
      });
    if (Object.hasOwn(spark, "enabled") && typeof spark["enabled"] !== "boolean")
      return yield* new ExperimentalFeatureFlagError({
        envName,
        message: `experimental.spark.enabled must be the literal true or false in ${file}: the command tree is chosen before env(...) references are read. Write true or false, or remove the key and set ${envName} in the shell.`,
      });
  });

const featureKeys = {
  stack: CliConfigKeys.experimental.stack,
  compute: CliConfigKeys.experimental.compute,
  spark: CliConfigKeys.experimental.spark.enabled,
} as const;

/**
 * Resolves one experimental boolean: a shell boolean override, else the project
 * config. Remotes and project `.env*` files do not apply.
 */
export const resolveExperimentalFeature = <E, R>(input: {
  readonly feature: keyof typeof featureKeys;
  readonly configValue: Effect.Effect<boolean | undefined, E, R>;
}): Effect.Effect<boolean, E | ExperimentalFeatureFlagError, R | Path.Path> =>
  Effect.gen(function* () {
    const key = featureKeys[input.feature];
    const envName = key.env[0] ?? `SUPABASE_EXPERIMENTAL_${input.feature.toUpperCase()}`;
    const path = yield* Path.Path;
    const shell = yield* readEnv(envName);
    const configValue = shell === undefined || shell === "" ? yield* input.configValue : undefined;
    const sources: CliConfigSources = {
      flags: () => undefined,
      shell: (name) => (name === envName ? shell : undefined),
      projectEnv: () => undefined,
      config: (segments) =>
        segments.join(".") === key.path && configValue !== undefined
          ? { value: configValue, origin: { path: segments, source: "local" } }
          : undefined,
      dotenvPrivateKeys: [],
      context: { workdir: "", projectRef: Option.none(), path, configAt: () => undefined },
    };
    const picked =
      input.feature === "spark"
        ? Result.map(pickCliConfigKey(featureKeys.spark, sources), ({ value }) => value)
        : Result.map(pickCliConfigKey(featureKeys[input.feature], sources), ({ value }) =>
            Option.getOrElse(value, () => false),
          );
    if (Result.isFailure(picked)) {
      return yield* new ExperimentalFeatureFlagError({
        envName,
        message: picked.failure.message,
      });
    }
    return picked.success;
  });
