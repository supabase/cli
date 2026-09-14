import { CliConfigSchema, findCliProjectPaths } from "@supabase/config/effect";
import { Data, Effect, FileSystem, Option, Path, Schema } from "effect";
import * as SmolToml from "smol-toml";
import { resolveWorkdir } from "../../../config/command-settings.layer.ts";
import { resolveExperimentalFeature } from "../../../command-internal/experimental-feature.ts";
import { extractCommandPath, hasRootVersionFlag, rootFlagTokens } from "../../../shared/cli/run.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

export type StackBackend = "legacy" | "stack";

export class StackRoutingError extends Data.TaggedError("StackRoutingError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  get suggestion(): string {
    return "Set SUPABASE_EXPERIMENTAL_STACK=1 to enable stack commands, or 0 to use legacy start/stop.";
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

const stackRoutingSchema = Schema.Struct({
  experimental: Schema.optionalKey(
    Schema.Struct({ stack: CliConfigSchema.fields.experimental.to.fields.stack }),
  ),
});

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
const decodeJson = Schema.decodeUnknownEffect(UnknownFromJsonString);

const parseConfig = (path: string, content: string): Effect.Effect<unknown, StackRoutingError> =>
  path.endsWith(".json")
    ? decodeJson(content).pipe(
        Effect.mapError(
          (cause) => new StackRoutingError({ message: `Unable to parse ${path}`, cause }),
        ),
      )
    : Effect.try({
        try: () => SmolToml.parse(content),
        catch: (cause) =>
          new StackRoutingError({
            message: `Unable to parse ${path}: ${String(cause)}`,
            cause,
          }),
      });

const stackSettingFrom = (
  path: string,
  document: unknown,
): Effect.Effect<boolean | undefined, StackRoutingError> =>
  Schema.decodeUnknownEffect(stackRoutingSchema)(document).pipe(
    Effect.map(({ experimental }) => experimental?.stack),
    Effect.mapError(
      (cause) =>
        new StackRoutingError({
          message: `Invalid experimental.stack in ${path}: expected a boolean value`,
          cause,
        }),
    ),
  );

const configValue = (input: {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Effect.Effect<boolean | undefined, StackRoutingError, FileSystem.FileSystem | Path.Path> =>
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
    const content = yield* fs.readFileString(project.configPath).pipe(
      Effect.mapError(
        (cause) =>
          new StackRoutingError({
            message: `Unable to read ${project.configPath}: ${String(cause)}`,
            cause,
          }),
      ),
    );
    return yield* parseConfig(project.configPath, content).pipe(
      Effect.flatMap((document) => stackSettingFrom(project.configPath, document)),
    );
  });

export const resolveStackBackend = (input: {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Effect.Effect<StackBackend, StackRoutingError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    // Completion passes the final token as the cursor word, so it is not part of
    // the resolved command path.
    const routingArgs =
      input.args[0] === "__complete" || input.args[0] === "__completeNoDesc"
        ? input.args.slice(0, -1)
        : input.args;
    if (hasRootVersionFlag(routingArgs)) return "legacy";

    const commandPath = extractCommandPath(routingArgs);
    const completePath =
      commandPath[0] === "__complete" || commandPath[0] === "__completeNoDesc"
        ? commandPath.slice(1)
        : commandPath;
    const command = completePath[0] === "help" ? completePath[1] : completePath[0];
    if (command !== undefined && command !== "stack" && command !== "start" && command !== "stop") {
      return "legacy";
    }

    const enabled = yield* resolveExperimentalFeature({
      feature: "stack",
      configValue: configValue({ ...input, args: routingArgs }).pipe(
        Effect.catchTag("StackRoutingError", () => Effect.succeed(false)),
      ),
      env: input.env,
    }).pipe(
      Effect.mapError((error) => new StackRoutingError({ message: error.message, cause: error })),
    );
    return enabled ? "stack" : "legacy";
  });
