import { Data, Effect, FileSystem, Path } from "effect";
import {
  readExperimentalFeatureConfig,
  resolveExperimentalFeature,
} from "../../../command-internal/experimental-feature.ts";
import { extractCommandPath, hasRootVersionFlag } from "../../../shared/cli/run.ts";
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
    return "Set SUPABASE_EXPERIMENTAL_STACK=1 to enable stack commands, or 0 to use legacy start/stop.";
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

export const resolveStackBackend = (input: {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Effect.Effect<StackBackend, StackRoutingError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    // Completion passes the final token as the cursor word, so it is not part of
    // the resolved command path.
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
    const command = completePath[0] === "help" ? completePath[1] : completePath[0];
    if (command !== undefined && command !== "stack" && command !== "start" && command !== "stop") {
      return "legacy";
    }

    const enabled = yield* resolveExperimentalFeature({
      feature: "stack",
      configValue: readExperimentalFeatureConfig({ feature: "stack", ...input, args: routingArgs }),
      env: input.env,
    }).pipe(
      Effect.mapError((error) => new StackRoutingError({ message: error.message, cause: error })),
    );
    return enabled ? "stack" : "legacy";
  });
