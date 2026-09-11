import { Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { stackStartCommand as stackStartCommandBase } from "./start/start.command.ts";
import { stackStopCommand as stackStopCommandBase } from "./stop/stop.command.ts";
import { stackStatusCommand as stackStatusCommandBase } from "./status/status.command.ts";
import { stackApiLayer, stackTargetResolverLayer } from "./stack.shared.ts";

export const stackRuntimeLayer = Layer.mergeAll(
  stackTargetResolverLayer,
  stackApiLayer,
  commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer)),
  telemetryStateLayer,
);

const stackStartCommand = stackStartCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "start"])),
);
const stackStopCommand = stackStopCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "stop"])),
);
const stackStatusCommand = stackStatusCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "status"])),
);

export const stackCommand = Command.make("stack").pipe(
  Command.withDescription(
    "Manage an experimental, unstable local Supabase stack with the new backend. This command is excluded from the CLI compatibility promise.",
  ),
  Command.withShortDescription("Manage experimental local stacks"),
  Command.withSubcommands([stackStartCommand, stackStatusCommand, stackStopCommand]),
  Command.provide(stackRuntimeLayer),
);
