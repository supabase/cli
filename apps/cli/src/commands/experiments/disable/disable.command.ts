import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import {
  EXPERIMENT_NAMES,
  experimentArgumentDescription,
} from "../../../command-internal/experiment-registry.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { experimentsRuntimeLayer } from "../experiments.layers.ts";
import { experimentsDisable } from "./disable.handler.ts";

const config = {
  features: Argument.choice("FEATURE", EXPERIMENT_NAMES).pipe(
    Argument.withDescription(experimentArgumentDescription("disable")),
    Argument.variadic({ min: 1 }),
  ),
} as const;

export type ExperimentsDisableFlags = CliCommand.Command.Config.Infer<typeof config>;

export const experimentsDisableCommand = Command.make("disable", config).pipe(
  Command.withDescription(
    "Disable one or more experiments by writing them to [experimental] in supabase/config.toml.",
  ),
  Command.withShortDescription("Disable experiments for this project"),
  Command.withExamples([
    {
      command: "supabase experiments disable compute",
      description: "Turn the compute command family back off for this project",
    },
  ]),
  Command.withHandler((flags) =>
    experimentsDisable(flags).pipe(
      // The feature names are a closed enum, so logging them verbatim carries no user data.
      withCommandTelemetry({ flags, safeFlags: ["features"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(experimentsRuntimeLayer(["experiments", "disable"])),
);
