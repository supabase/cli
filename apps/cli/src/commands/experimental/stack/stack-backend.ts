import { CliConfigSchema } from "@supabase/config/effect";
import { Data, Effect, FileSystem, Option, Path, Schema } from "effect";
import { legacyResolveWorkdir } from "../../../config/legacy-cli-settings.layer.ts";
import * as SmolToml from "smol-toml";
import { hasRootVersionFlag, rootFlagTokens } from "../../../shared/cli/run.ts";
import { BOOLEAN_FLAG_VALUES, ROOT_BOOLEAN_FLAGS } from "../../../shared/cli/agent-output.ts";
import { GLOBAL_VALUE_FLAG_TOKENS } from "../../../shared/cli/cobra-flag-groups.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

export type LegacyExperimentalStackBackend = "legacy" | "stack";

export class LegacyExperimentalStackRoutingError extends Data.TaggedError(
  "LegacyExperimentalStackRoutingError",
)<{ readonly message: string; readonly cause?: unknown }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

const stackRoutingSchema = Schema.Struct({
  experimental: Schema.optionalKey(
    Schema.Struct({ stack: CliConfigSchema.fields.experimental.to.fields.stack }),
  ),
});

const legacyFirstExplicitLongFlagValue = (
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
const legacyExtractStackRoutingCommandPath = (
  args: ReadonlyArray<string>,
): ReadonlyArray<string> => {
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

const parseConfig = (
  path: string,
  content: string,
): Effect.Effect<unknown, LegacyExperimentalStackRoutingError> =>
  Effect.try({
    try: () => SmolToml.parse(content),
    catch: (cause) =>
      new LegacyExperimentalStackRoutingError({
        message: `Unable to read ${path}: ${String(cause)}`,
        cause,
      }),
  });

const stackSettingFrom = (
  path: string,
  document: unknown,
): Effect.Effect<LegacyExperimentalStackBackend, LegacyExperimentalStackRoutingError> => {
  return Schema.decodeUnknownEffect(stackRoutingSchema)(document).pipe(
    Effect.map(({ experimental }) => (experimental?.stack === true ? "stack" : "legacy")),
    Effect.mapError(
      (cause) =>
        new LegacyExperimentalStackRoutingError({
          message: `Invalid experimental.stack in ${path}: expected a boolean value`,
          cause,
        }),
    ),
  );
};

export const legacyResolveExperimentalStackBackend = (input: {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Effect.Effect<
  LegacyExperimentalStackBackend,
  LegacyExperimentalStackRoutingError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    if (hasRootVersionFlag(input.args)) return "legacy";
    const commandPath = legacyExtractStackRoutingCommandPath(input.args);
    const completePath =
      commandPath[0] === "__complete" || commandPath[0] === "__completeNoDesc"
        ? commandPath.slice(1)
        : commandPath;
    const command = completePath[0];
    if (command === "stack") return "stack";
    if (command !== "start" && command !== "stop" && command !== "status") {
      return "legacy";
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const explicitWorkdir = legacyFirstExplicitLongFlagValue(input.args, "workdir");
    const resolvedWorkdir = yield* legacyResolveWorkdir(
      explicitWorkdir === undefined ? Option.none() : Option.some(explicitWorkdir),
      input.env["SUPABASE_WORKDIR"],
      input.cwd,
      (filePath) => fs.exists(filePath).pipe(Effect.orElseSucceed(() => false)),
      path,
    );
    const configPath = path.join(resolvedWorkdir.workdir, "supabase", "config.toml");
    const configExists = yield* fs.exists(configPath).pipe(Effect.orElseSucceed(() => false));
    if (!configExists) return "legacy";
    const content = yield* fs.readFileString(configPath).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyExperimentalStackRoutingError({
            message: `Unable to read ${configPath}: ${String(cause)}`,
            cause,
          }),
      ),
    );
    return yield* parseConfig(configPath, content).pipe(
      Effect.flatMap((document) => stackSettingFrom(configPath, document)),
    );
  });
