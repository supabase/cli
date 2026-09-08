import { Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { legacyCliSettingsLayer } from "../../../config/legacy-cli-settings.layer.ts";
import { legacyDebugLoggerLayer } from "../../../command-internal/legacy-debug-logger.layer.ts";
import { legacyExperimentalStackStartCommand } from "./start/start.command.ts";
import {
  legacyExperimentalStackApiLayer,
  legacyExperimentalStackTargetResolverLayer,
} from "./stack.shared.ts";

export const legacyExperimentalStackCommand = Command.make("stack").pipe(
  Command.withDescription("Manage an experimental managed local Supabase stack."),
  Command.withShortDescription("Manage a managed local stack"),
  Command.withSubcommands([legacyExperimentalStackStartCommand]),
  Command.provide(legacyExperimentalStackTargetResolverLayer),
  Command.provide(legacyExperimentalStackApiLayer),
  Command.provide(legacyCliSettingsLayer.pipe(Layer.provide(legacyDebugLoggerLayer))),
);
