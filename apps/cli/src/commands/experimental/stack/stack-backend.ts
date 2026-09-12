import { CliConfigSchema } from "@supabase/config/effect";
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
    return "Set SUPABASE_EXPERIMENTAL_STACK=0 to use legacy start/stop/status, or use `supabase stack`.";
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

const parseConfig = (path: string, content: string): Effect.Effect<unknown, StackRoutingError> =>
  Effect.try({
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

export const resolveStackBackend = (input: {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Effect.Effect<StackBackend, StackRoutingError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    // Completion passes the final token as the cursor word, even when it is a
    // command-shaped token such as `start`. It must not select a backend or
    // trigger config I/O until the user has supplied a complete command path.
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
    const command = completePath[0];

    // The explicit namespace is always backed by the stack runtime and does
    // not need a project config or environment lookup to select it.
    if (command === "stack") return "stack";
    if (command !== "start" && command !== "stop" && command !== "status") return "legacy";

    const configValue = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const explicitWorkdir = firstExplicitLongFlagValue(routingArgs, "workdir");
      const resolvedWorkdir = yield* resolveWorkdir(
        explicitWorkdir === undefined ? Option.none() : Option.some(explicitWorkdir),
        input.env["SUPABASE_WORKDIR"],
        input.cwd,
        (filePath) => fs.exists(filePath).pipe(Effect.orElseSucceed(() => false)),
        path,
      );
      const configPath = path.join(resolvedWorkdir.workdir, "supabase", "config.toml");
      const configExists = yield* fs.exists(configPath).pipe(Effect.orElseSucceed(() => false));
      if (!configExists) return undefined;
      const content = yield* fs.readFileString(configPath).pipe(
        Effect.mapError(
          (cause) =>
            new StackRoutingError({
              message: `Unable to read ${configPath}: ${String(cause)}`,
              cause,
            }),
        ),
      );
      return yield* parseConfig(configPath, content).pipe(
        Effect.flatMap((document) => stackSettingFrom(configPath, document)),
      );
    }).pipe(Effect.catchTag("StackRoutingError", () => Effect.succeed(false)));
    const enabled = yield* resolveExperimentalFeature({
      feature: "stack",
      configValue,
      env: input.env,
    }).pipe(
      Effect.mapError((error) => new StackRoutingError({ message: error.message, cause: error })),
    );
    return enabled ? "stack" : "legacy";
  });
