import { CliConfigSchema, findCliProjectPaths } from "@supabase/config/effect";
import { Config, Data, Effect, FileSystem, Option, Path, Result, Schema } from "effect";
import * as SmolToml from "smol-toml";
import { pickCliConfigKey } from "../config/cli-config-key.ts";
import { CliConfigKeys } from "../config/cli-config-keys.ts";
import { resolveWorkdir } from "../config/command-settings.layer.ts";
import { rootFlagTokens } from "../shared/cli/run.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

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
} as const;

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

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);

const readEnv = (name: string) =>
  Config.option(Config.string(name)).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
    Effect.map(Option.getOrUndefined),
  );

/** Reads one experimental feature, treating unavailable or invalid configuration as unset. */
export const readExperimentalFeatureConfig = (input: {
  readonly feature: keyof typeof featureSchemas;
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
      (filePath) => fs.exists(filePath).pipe(Effect.orElseSucceed(() => false)),
      path,
    );
    const project = yield* findCliProjectPaths(resolvedWorkdir.workdir, {
      search: !resolvedWorkdir.explicit,
    });
    if (project === null) return undefined;
    const content = yield* fs.readFileString(project.configPath);
    const document = project.configPath.endsWith(".json")
      ? yield* Schema.decodeEffect(UnknownFromJsonString)(content)
      : yield* Effect.try(() => SmolToml.parse(content));
    const schema = Schema.Struct({
      experimental: Schema.optionalKey(
        Schema.Struct({ [input.feature]: featureSchemas[input.feature] }),
      ),
    });
    const decoded = yield* Schema.decodeUnknownEffect(schema)(document);
    return decoded.experimental?.[input.feature];
  }).pipe(Effect.orElseSucceed(() => undefined));

const featureKeys = {
  stack: CliConfigKeys.experimental.stack,
  compute: CliConfigKeys.experimental.compute,
} as const;

/**
 * Resolves one experimental boolean: a strict `0`/`1` shell override, else the project
 * config. Remotes and project `.env*` files do not apply.
 */
export const resolveExperimentalFeature = <E, R>(input: {
  readonly feature: keyof typeof featureKeys;
  readonly configValue: Effect.Effect<boolean | undefined, E, R>;
}): Effect.Effect<boolean, E | ExperimentalFeatureFlagError, R | Path.Path> =>
  Effect.gen(function* () {
    const key = featureKeys[input.feature];
    const envName = `SUPABASE_EXPERIMENTAL_${input.feature.toUpperCase()}`;
    const path = yield* Path.Path;
    const shell = yield* readEnv(envName);
    const configValue = shell === undefined || shell === "" ? yield* input.configValue : undefined;
    const picked = pickCliConfigKey(key, {
      flags: () => undefined,
      shell: (name) => (name === envName ? shell : undefined),
      projectEnv: () => undefined,
      config: (configPath) =>
        configPath === key.path && configValue !== undefined
          ? { value: configValue, origin: { path: configPath.split("."), source: "local" } }
          : undefined,
      dotenvPrivateKeys: [],
      context: { workdir: "", projectRef: Option.none(), path, configAt: () => undefined },
    });
    if (Result.isFailure(picked)) {
      return yield* new ExperimentalFeatureFlagError({
        envName,
        message: picked.failure.message,
      });
    }
    return Option.getOrElse(picked.success.value, () => false);
  });
