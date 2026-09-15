import { CliConfigSchema, findCliProjectPaths } from "@supabase/config/effect";
import { Data, Effect, FileSystem, Option, Path, Schema } from "effect";
import * as SmolToml from "smol-toml";
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

/**
 * The one boolean a gate needs, from either shape an experimental flag takes: `stack` is a
 * bare `stack = true`, while `compute` is a `[experimental.compute]` table carrying
 * `enabled`, the same shape as `[experimental.pgdelta]` and `[experimental.webhooks]`.
 *
 * Shape-checked rather than typed per feature because the decoded type of a computed-key
 * struct is an index signature over every feature's schema, so neither branch narrows. The
 * schema has already validated whichever shape arrived; this only has to pick the boolean
 * out of it.
 */
const featureEnabled = (configured: unknown): boolean | undefined => {
  if (typeof configured === "boolean") return configured;
  if (typeof configured === "object" && configured !== null && "enabled" in configured) {
    const { enabled } = configured as { readonly enabled?: unknown };
    return typeof enabled === "boolean" ? enabled : undefined;
  }
  return undefined;
};

/** Reads one experimental feature, treating unavailable or invalid configuration as unset. */
export const readExperimentalFeatureConfig = (input: {
  readonly feature: keyof typeof featureSchemas;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Effect.Effect<boolean | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const explicitWorkdir = firstExplicitLongFlagValue(input.args, "workdir");
    const resolvedWorkdir = yield* resolveWorkdir(
      explicitWorkdir === undefined ? Option.none() : Option.some(explicitWorkdir),
      input.env["SUPABASE_WORKDIR"],
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
    return featureEnabled(decoded.experimental?.[input.feature]);
  }).pipe(Effect.orElseSucceed(() => undefined));

/** Resolves one experimental boolean from its environment override and config fallback. */
export const resolveExperimentalFeature = <E, R>(input: {
  readonly feature: string;
  readonly configValue: Effect.Effect<boolean | undefined, E, R>;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Effect.Effect<boolean, E | ExperimentalFeatureFlagError, R> => {
  const envName = `SUPABASE_EXPERIMENTAL_${input.feature.toUpperCase()}`;
  const override = input.env[envName];
  if (override === undefined || override === "") {
    return input.configValue.pipe(Effect.map((value) => value === true));
  }
  if (override === "1") return Effect.succeed(true);
  if (override === "0") return Effect.succeed(false);
  return Effect.fail(
    new ExperimentalFeatureFlagError({
      envName,
      message: `${envName} must be 0 or 1 when set`,
    }),
  );
};
