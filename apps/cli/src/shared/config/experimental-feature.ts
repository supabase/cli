import { CliConfigSchema, findCliProjectPaths } from "@supabase/config/effect";
import { cliConfigFormatForPath, parseCliConfigDocument } from "@supabase/config/internal";
import {
  Config,
  Console,
  Context,
  Data,
  Effect,
  FileSystem,
  Option,
  Path,
  Result,
  Schema,
} from "effect";
import { pickCliConfigKey } from "../../config/cli-config-key.ts";
import { CliConfigKeys } from "../../config/cli-config-keys.ts";
import { resolveWorkdir } from "../../config/command-settings.layer.ts";
import { yellow } from "../../command-internal/colors.ts";
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
} as const;

const featureKeys = {
  stack: CliConfigKeys.experimental.stack.enabled,
  compute: CliConfigKeys.experimental.compute.enabled,
} as const;

type ExperimentalFeature = keyof typeof featureKeys;

/** Deprecation warnings already printed in this process, so each prints once. */
export const WarnedExperimentalDeprecations = Context.Reference<Set<string>>(
  "supabase/cli/WarnedExperimentalDeprecations",
  { defaultValue: () => new Set() },
);

/** Prints a deprecation warning on stderr; stdout may carry the command's payload. */
const warnDeprecated = Effect.fnUntraced(function* (message: string) {
  const warned = yield* WarnedExperimentalDeprecations;
  if (warned.has(message)) return;
  warned.add(message);
  yield* Console.error(yellow(`Warning: ${message}`));
});

// Legacy forms: `SUPABASE_EXPERIMENTAL_<FEATURE>` is a second env name of the feature's key (see
// CLI_CONFIG_ENV_NAME_PATHS) and `experimental.<feature> = <bool>` is a second document shape. Both
// can go once the table form has been the only documented one for a release.
const legacyEnvWarning = (envName: string, canonical: string): string =>
  `\`${envName}\` is deprecated; use \`${canonical}\`.`;

const legacyConfigWarning = (feature: ExperimentalFeature, value: boolean): string =>
  `\`experimental.${feature} = ${value}\` is deprecated; use \`enabled = ${value}\` under \`[experimental.${feature}]\`.`;

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
    const legacy = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        experimental: Schema.optionalKey(
          Schema.Struct({ [input.feature]: Schema.optionalKey(Schema.Boolean) }),
        ),
      }),
    )(document).pipe(Effect.orElseSucceed(() => undefined));
    const legacyValue = legacy?.experimental?.[input.feature];
    if (legacyValue !== undefined) {
      yield* warnDeprecated(legacyConfigWarning(input.feature, legacyValue));
    }
    return decoded.experimental?.[input.feature]?.enabled;
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Resolves one experimental boolean: a shell boolean override, else the project
 * config. Remotes and project `.env*` files do not apply.
 */
export const resolveExperimentalFeature = <E, R>(input: {
  readonly feature: ExperimentalFeature;
  readonly configValue: Effect.Effect<boolean | undefined, E, R>;
}): Effect.Effect<boolean, E | ExperimentalFeatureFlagError, R | Path.Path> =>
  Effect.gen(function* () {
    const key = featureKeys[input.feature];
    const [canonicalEnvName = key.path] = key.env;
    const path = yield* Path.Path;
    const shell = new Map<string, string>();
    for (const name of key.env) {
      const value = yield* readEnv(name);
      if (value !== undefined) shell.set(name, value);
    }
    const shellSet = key.env.some((name) => (shell.get(name) ?? "") !== "");
    const configValue = shellSet ? undefined : yield* input.configValue;
    const picked = pickCliConfigKey(key, {
      flags: () => undefined,
      shell: (name) => shell.get(name),
      projectEnv: () => undefined,
      config: (segments) =>
        segments.join(".") === key.path && configValue !== undefined
          ? { value: configValue, origin: { path: segments, source: "local" } }
          : undefined,
      dotenvPrivateKeys: [],
      context: { workdir: "", projectRef: Option.none(), path, configAt: () => undefined },
    });
    if (Result.isFailure(picked)) {
      return yield* new ExperimentalFeatureFlagError({
        envName: picked.failure.envName ?? canonicalEnvName,
        message: picked.failure.message,
      });
    }
    const { origin } = picked.success;
    if (origin.tier === "shell" && origin.envName !== canonicalEnvName) {
      yield* warnDeprecated(legacyEnvWarning(origin.envName, canonicalEnvName));
    }
    return Option.getOrElse(picked.success.value, () => false);
  });
