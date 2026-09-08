import { Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { experimentalStackStartCommand } from "./start/start.command.ts";
import { experimentalStackApiLayer, experimentalStackTargetResolverLayer } from "./stack.shared.ts";

export const experimentalStackCommand = Command.make("stack").pipe(
  Command.withDescription("Manage an experimental managed local Supabase stack."),
  Command.withShortDescription("Manage a managed local stack"),
  Command.withSubcommands([experimentalStackStartCommand]),
  Command.provide(experimentalStackTargetResolverLayer),
  Command.provide(experimentalStackApiLayer),
  Command.provide(commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer))),
  Command.provide(telemetryStateLayer),
);
