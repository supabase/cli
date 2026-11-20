import { Effect, FileSystem, Path } from "effect";
import {
  ExperimentalFeatureFlagError,
  readExperimentalFeatureConfig,
  resolveExperimentalFeature,
} from "../../../shared/config/experimental-feature.ts";
import { routingArgsFor } from "../../../command-internal/routing-args.ts";

export const resolveComputeEnabled = (input: {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}): Effect.Effect<boolean, ExperimentalFeatureFlagError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const routing = routingArgsFor(input.args);
    if (routing === undefined) return false;
    const { routingArgs, path } = routing;
    if (path[0] !== undefined && path[0] !== "compute") return false;
    return yield* resolveExperimentalFeature({
      feature: "compute",
      configValue: readExperimentalFeatureConfig({
        feature: "compute",
        ...input,
        args: routingArgs,
      }),
    });
  });
