import { CliConfigSchema } from "@supabase/config/effect";
import { Data, Effect, FileSystem, Option, Path, Schema } from "effect";
import * as SmolToml from "smol-toml";
import { resolveWorkdir } from "../../../config/command-settings.layer.ts";
import { resolveExperimentalFeature } from "../../../command-internal/experimental-feature.ts";
import { BOOLEAN_FLAG_VALUES, ROOT_BOOLEAN_FLAGS } from "../../../shared/cli/agent-output.ts";
import { GLOBAL_VALUE_FLAG_TOKENS } from "../../../shared/cli/cobra-flag-groups.ts";
import { hasRootVersionFlag, rootFlagTokens } from "../../../shared/cli/run.ts";
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
    return "Set SUPABASE_EXPERIMENTAL_STACK=0 to use legacy start/stop, or use `supabase stack`.";
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

/** Extracts command path tokens while honoring optional separated boolean values. */
const extractRoutingCommandPath = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const commandPath: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || arg === "--") break;
    if (!arg.startsWith("-")) {
      commandPath.push(arg);
      continue;
    }
    const [flag] = arg.split("=", 1);
    if (!arg.includes("=") && flag !== undefined && GLOBAL_VALUE_FLAG_TOKENS.has(flag)) {
      index += 1;
      continue;
    }
    if (
      !arg.includes("=") &&
      flag !== undefined &&
      ROOT_BOOLEAN_FLAGS.includes(flag) &&
      BOOLEAN_FLAG_VALUES.has(args[index + 1] ?? "")
    )
      index += 1;
  }
  return commandPath;
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

    const commandPath = extractRoutingCommandPath(routingArgs);
    const completePath =
      commandPath[0] === "__complete" || commandPath[0] === "__completeNoDesc"
        ? commandPath.slice(1)
        : commandPath;
    const command = completePath[0];

    // The explicit namespace is always backed by the stack runtime and does
    // not need a project config or environment lookup to select it.
    if (command === "stack") return "stack";
    if (command !== "start" && command !== "stop") return "legacy";

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
    });
    const enabled = yield* resolveExperimentalFeature({
      feature: "stack",
      configValue,
      env: input.env,
    }).pipe(
      Effect.mapError((error) =>
        error instanceof StackRoutingError
          ? error
          : new StackRoutingError({ message: error.message, cause: error }),
      ),
    );
    return enabled ? "stack" : "legacy";
  });
