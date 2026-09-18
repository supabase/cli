import { Effect, FileSystem, Path } from "effect";
import {
  ExperimentalFeatureFlagError,
  readExperimentalFeatureConfig,
  resolveExperimentalFeature,
} from "../../../command-internal/experimental-feature.ts";
import { extractCommandPath, hasRootVersionFlag } from "../../../shared/cli/run.ts";

export const resolveComputeEnabled = (input: {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
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
    if (completePath[0] !== undefined && completePath[0] !== "compute") return false;
    return yield* resolveExperimentalFeature({
      feature: "compute",
      configValue: readExperimentalFeatureConfig({
        feature: "compute",
        ...input,
        args: routingArgs,
      }),
      env: input.env,
    });
  });
