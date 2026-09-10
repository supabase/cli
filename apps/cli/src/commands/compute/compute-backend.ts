import { CliConfigSchema, findCliProjectPaths } from "@supabase/config/effect";
import { Data, Effect, FileSystem, Option, Path, Schema } from "effect";
import * as SmolToml from "smol-toml";
import { resolveWorkdir } from "../../config/command-settings.layer.ts";
import { resolveExperimentalFeature } from "../../command-internal/experimental-feature.ts";
import { hasRootVersionFlag, rootFlagTokens } from "../../shared/cli/run.ts";

const computeRoutingSchema = Schema.Struct({
  experimental: Schema.optionalKey(
    Schema.Struct({ compute: CliConfigSchema.fields.experimental.to.fields.compute }),
  ),
});

class ComputeRoutingError extends Data.TaggedError("ComputeRoutingError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const firstExplicitWorkdir = (args: ReadonlyArray<string>): string | undefined => {
  for (const { token, index } of rootFlagTokens(args)) {
    if (token === "--workdir") return args[index + 1];
    if (token.startsWith("--workdir=")) return token.slice("--workdir=".length);
  }
  return undefined;
};

const parseDocument = (
  path: string,
  content: string,
): Effect.Effect<unknown, ComputeRoutingError> =>
  Effect.try({
    try: () => (path.endsWith(".json") ? JSON.parse(content) : SmolToml.parse(content)),
    catch: (cause) => new ComputeRoutingError({ message: `Unable to parse ${path}`, cause }),
  });

const readComputeSetting = (
  path: string,
  document: unknown,
): Effect.Effect<boolean | undefined, ComputeRoutingError> =>
  Schema.decodeUnknownEffect(computeRoutingSchema)(document).pipe(
    Effect.map(({ experimental }) => experimental?.compute),
    Effect.mapError(
      (cause) =>
        new ComputeRoutingError({
          message: `Invalid compute setting in ${path}: expected a boolean value`,
          cause,
        }),
    ),
  );

const configValue = (input: {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Effect.Effect<boolean | undefined, ComputeRoutingError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const explicit = firstExplicitWorkdir(input.args);
    const resolved = yield* resolveWorkdir(
      explicit === undefined ? Option.none() : Option.some(explicit),
      input.env["SUPABASE_WORKDIR"],
      input.cwd,
      (filePath) => fs.exists(filePath).pipe(Effect.orElseSucceed(() => false)),
      path,
    );
    const project = yield* findCliProjectPaths(resolved.workdir, {
      search: !resolved.explicit,
    });
    if (project === null) return undefined;
    const content = yield* fs
      .readFileString(project.configPath)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ComputeRoutingError({ message: `Unable to read ${project.configPath}`, cause }),
        ),
      );
    return yield* parseDocument(project.configPath, content).pipe(
      Effect.flatMap((document) => readComputeSetting(project.configPath, document)),
    );
  });

export const resolveComputeEnabled = (input: {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const routingArgs =
      input.args[0] === "__complete" || input.args[0] === "__completeNoDesc"
        ? input.args.slice(0, -1)
        : input.args;
    if (hasRootVersionFlag(routingArgs)) return false;
    return yield* resolveExperimentalFeature({
      feature: "compute",
      configValue: configValue({ ...input, args: routingArgs }).pipe(
        Effect.catchTag("ComputeRoutingError", () => Effect.succeed(undefined)),
      ),
      env: input.env,
    }).pipe(Effect.catchTag("ExperimentalFeatureFlagError", () => Effect.succeed(false)));
  });
