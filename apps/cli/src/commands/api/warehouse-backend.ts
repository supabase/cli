import { Effect, FileSystem, Path } from "effect";

import { extractCommandPath, hasRootVersionFlag } from "../../shared/cli/run.ts";
import {
  type ExperimentalFeatureFlagError,
  readExperimentalFeatureConfig,
  resolveExperimentalFeature,
} from "../../shared/config/experimental-feature.ts";

/** Resolves `experimental.warehouse` only for invocations that can reach the `warehouse` group. */
export const resolveWarehouseEnabled = (input: {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}): Effect.Effect<boolean, ExperimentalFeatureFlagError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const routingArgs =
      input.args[0] === "__complete" || input.args[0] === "__completeNoDesc"
        ? input.args.slice(0, -1)
        : input.args;
    if (hasRootVersionFlag(routingArgs)) return false;
    const commandPath = extractCommandPath(routingArgs);
    const completePath =
      commandPath[0] === "__complete" || commandPath[0] === "__completeNoDesc"
        ? commandPath.slice(1)
        : commandPath;
    if (completePath[0] !== undefined && completePath[0] !== "warehouse") return false;
    return yield* resolveExperimentalFeature({
      feature: "warehouse",
      configValue: readExperimentalFeatureConfig({
        feature: "warehouse",
        ...input,
        args: routingArgs,
      }),
    });
  });
