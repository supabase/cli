import { CliConfigSchema, findCliProjectPaths } from "@supabase/config/effect";
import { cliConfigFormatForPath, parseCliConfigDocument } from "@supabase/config/internal";
import { Config, Data, Effect, FileSystem, Option, Path, Result, Schema } from "effect";
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

/** The opt-in boolean inside a decoded feature value; `[experimental.spark]` is a table. */
const featureEnabled = (feature: ExperimentalFeature, value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (feature === "spark" && typeof value === "object" && value !== null && "enabled" in value)
    return typeof value.enabled === "boolean" ? value.enabled : undefined;
  return undefined;
};

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

/** Reads one experimental feature, treating unavailable or invalid configuration as unset. */
export const readExperimentalFeatureConfig = (input: {
  readonly feature: ExperimentalFeature;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}): Effect.Effect<boolean | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
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
    const schema = Schema.Struct({
      experimental: Schema.optionalKey(
        Schema.Struct({ [input.feature]: featureSchemas[input.feature] }),
      ),
    });
    const decoded = yield* Schema.decodeUnknownEffect(schema)(document);
    return featureEnabled(input.feature, decoded.experimental?.[input.feature]);
  }).pipe(Effect.orElseSucceed(() => undefined));

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
