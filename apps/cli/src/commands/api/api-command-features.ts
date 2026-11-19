import { Effect, type FileSystem, type Path } from "effect";

import { routingArgsFor } from "../../command-internal/routing-args.ts";
import {
  type ExperimentalFeature,
  type ExperimentalFeatureFlagError,
  readExperimentalFeatureConfig,
  resolveExperimentalFeature,
} from "../../shared/config/experimental-feature.ts";
import { nouns } from "./api-command-policy.ts";

const nounFeatures = (noun: string | undefined): ReadonlyArray<ExperimentalFeature> => {
  if (noun === undefined) return [...new Set(Object.values(nouns).map(({ feature }) => feature))];
  const definition = Object.entries(nouns).find(([name]) => name === noun)?.[1];
  return definition === undefined ? [] : [definition.feature];
};

/**
 * Resolves the experimental features that gate generated API command groups, reading
 * configuration only for the features this invocation can reach: every noun feature when no
 * command is named (root help and completion), the named noun's feature otherwise.
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
    const routing = routingArgsFor(input.args);
    if (routing === undefined) return [];
    const { routingArgs, path } = routing;
    const enabled = yield* Effect.filter(nounFeatures(path[0]), (feature) =>
      resolveExperimentalFeature({
        feature,
        configValue: readExperimentalFeatureConfig({ feature, cwd: input.cwd, args: routingArgs }),
      }),
    );
    yield* Effect.annotateCurrentSpan("features", enabled);
    return enabled;
  },
);
