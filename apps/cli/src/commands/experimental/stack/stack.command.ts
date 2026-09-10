import { Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { experimentalStackStartCommand } from "./start/start.command.ts";
import { experimentalStackStopCommand } from "./stop/stop.command.ts";
import { experimentalStackApiLayer, experimentalStackTargetResolverLayer } from "./stack.shared.ts";

export const experimentalStackRuntimeLayer = Layer.mergeAll(
  experimentalStackTargetResolverLayer,
  experimentalStackApiLayer,
  commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer)),
  telemetryStateLayer,
);

const stackStartCommand = experimentalStackStartCommand.pipe(
  Command.provide(commandRuntimeLayer(["stack", "start"])),
);
const stackStopCommand = experimentalStackStopCommand.pipe(
  Command.provide(commandRuntimeLayer(["stack", "stop"])),
);

export const stackCommand = Command.make("stack").pipe(
  Command.withDescription(
    "Manage an experimental, unstable local Supabase stack with the new backend. This command is excluded from the CLI compatibility promise.",
  ),
  Command.withShortDescription("Manage experimental local stacks"),
  Command.withSubcommands([stackStartCommand, stackStopCommand]),
  Command.provide(experimentalStackRuntimeLayer),
);
