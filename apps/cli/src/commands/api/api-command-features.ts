import { Effect, type FileSystem, type Path } from "effect";

import { extractCommandPath, hasRootVersionFlag } from "../../shared/cli/run.ts";
import {
  type ExperimentalFeature,
  type ExperimentalFeatureFlagError,
  readExperimentalFeatureConfig,
  resolveExperimentalFeature,
} from "../../shared/config/experimental-feature.ts";
import { apiCommands } from "./generated.ts";

const pathFeatures = (path: ReadonlyArray<string>): ReadonlyArray<ExperimentalFeature> => [
  ...new Set(
    apiCommands
      .filter((entry) =>
        path.slice(0, entry.command.length).every((word, index) => word === entry.command[index]),
      )
      .map((entry) => entry.feature),
  ),
];

/**
 * Resolves the experimental features that gate generated API command groups, reading
 * configuration only for the features this invocation can reach: features beneath the requested
 * path, including root help and completion. Unrelated hand-written siblings do not read them.
 */
export const resolveApiCommandFeatures = Effect.fn("ApiCommands.resolveFeatures")(
  function* (input: {
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
  }): Effect.fn.Return<
    ReadonlyArray<ExperimentalFeature>,
    ExperimentalFeatureFlagError,
    FileSystem.FileSystem | Path.Path
  > {
    const routingArgs =
      input.args[0] === "__complete" || input.args[0] === "__completeNoDesc"
        ? input.args.slice(0, -1)
        : input.args;
    if (hasRootVersionFlag(routingArgs)) return [];
    const commandPath = extractCommandPath(routingArgs);
    const completePath =
      commandPath[0] === "__complete" || commandPath[0] === "__completeNoDesc"
        ? commandPath.slice(1)
        : commandPath;
    const enabled = yield* Effect.filter(pathFeatures(completePath), (feature) =>
      resolveExperimentalFeature({
        feature,
        configValue: readExperimentalFeatureConfig({ feature, cwd: input.cwd, args: routingArgs }),
      }),
    );
    yield* Effect.annotateCurrentSpan("features", enabled);
    return enabled;
  },
);
