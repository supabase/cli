import { CliConfigSchema, findCliProjectPaths } from "@supabase/config/effect";
import { Data, Effect, FileSystem, Path, Schema } from "effect";
import * as SmolToml from "smol-toml";
import { extractCommandPath, hasRootVersionFlag } from "../../../shared/cli/run.ts";
import { lastExplicitLongFlagValue } from "../../../shared/cli/cobra-flag-groups.ts";
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

const parseConfig = (
  path: string,
  content: string,
): Effect.Effect<unknown, LegacyExperimentalStackRoutingError> =>
  path.endsWith(".json")
    ? Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(content).pipe(
        Effect.mapError(
          (cause) =>
            new LegacyExperimentalStackRoutingError({
              message: `Unable to read ${path}: ${String(cause)}`,
              cause,
            }),
        ),
      )
    : Effect.try({
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
    const commandPath = extractCommandPath(input.args);
    const completePath = commandPath[0] === "__complete" ? commandPath.slice(1) : commandPath;
    const command = completePath[0];
    if (command === "stack") return "stack";
    if (command !== "start" && command !== "stop" && command !== "status") {
      return "legacy";
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const explicitWorkdir = lastExplicitLongFlagValue(input.args, [], "workdir");
    const configuredWorkdir =
      explicitWorkdir === undefined || explicitWorkdir.length === 0
        ? input.env["SUPABASE_WORKDIR"]
        : explicitWorkdir;
    const start =
      configuredWorkdir === undefined || configuredWorkdir.length === 0
        ? input.cwd
        : path.resolve(input.cwd, configuredWorkdir);
    const project = yield* findCliProjectPaths(start, {
      search: configuredWorkdir === undefined || configuredWorkdir.length === 0,
    });
    if (project === null) return "legacy";
    const content = yield* fs.readFileString(project.configPath).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyExperimentalStackRoutingError({
            message: `Unable to read ${project.configPath}: ${String(cause)}`,
            cause,
          }),
      ),
    );
    return yield* parseConfig(project.configPath, content).pipe(
      Effect.flatMap((document) => stackSettingFrom(project.configPath, document)),
    );
  });
