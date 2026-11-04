import { Effect, FileSystem, Path } from "effect";
import {
  ExperimentalFeatureFlagError,
  readExperimentalFeatureConfig,
  resolveExperimentalFeature,
} from "../../../shared/config/experimental-feature.ts";
import { extractCommandPath, hasRootVersionFlag } from "../../../shared/cli/run.ts";

export const resolveComputeEnabled = (input: {
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
    const customSql = routingArgs.some(
      (argument) =>
        argument === "--sql" ||
        argument.startsWith("--sql=") ||
        argument === "--file" ||
        argument.startsWith("--file=") ||
        argument === "-f" ||
        argument.startsWith("-f="),
    );
    const logsCapability = completePath[0] === "logs" && !customSql;
    if (completePath[0] !== undefined && completePath[0] !== "compute" && !logsCapability)
      return false;
    return yield* resolveExperimentalFeature({
      feature: "compute",
      configValue: readExperimentalFeatureConfig({
        feature: "compute",
        ...input,
        args: routingArgs,
      }),
    });
  });
