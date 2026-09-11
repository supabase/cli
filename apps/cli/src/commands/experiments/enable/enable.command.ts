import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import {
  EXPERIMENT_NAMES,
  experimentArgumentDescription,
} from "../../../command-internal/experiment-registry.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { experimentsRuntimeLayer } from "../experiments.layers.ts";
import { experimentsEnable } from "./enable.handler.ts";

const config = {
  features: Argument.choice("FEATURE", EXPERIMENT_NAMES).pipe(
    Argument.withDescription(experimentArgumentDescription("enable")),
    Argument.variadic({ min: 1 }),
  ),
} as const;

export type ExperimentsEnableFlags = CliCommand.Command.Config.Infer<typeof config>;

export const experimentsEnableCommand = Command.make("enable", config).pipe(
  Command.withDescription(
    "Enable one or more experiments by writing them to [experimental] in supabase/config.toml.",
  ),
  Command.withShortDescription("Enable experiments for this project"),
  Command.withExamples([
    {
      command: "supabase experiments enable compute",
      description: "Enable the compute command family for this project",
    },
    {
      command: "supabase experiments enable compute stack",
      description: "Enable several experiments at once",
    },
  ]),
  Command.withHandler((flags) =>
    experimentsEnable(flags).pipe(
      // The feature names are a closed enum, so logging them verbatim carries no user data.
      withCommandTelemetry({ flags, safeFlags: ["features"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(experimentsRuntimeLayer(["experiments", "enable"])),
);
