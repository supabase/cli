import { Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { legacyCliSettingsLayer } from "../../../config/legacy-cli-settings.layer.ts";
import { legacyDebugLoggerLayer } from "../../../command-internal/legacy-debug-logger.layer.ts";
import { legacyExperimentalStackStartCommand } from "./start/start.command.ts";
import { legacyExperimentalStackStopCommand } from "./stop/stop.command.ts";
import { legacyExperimentalStackStatusCommand } from "./status/status.command.ts";
import { legacyExperimentalStackListCommand } from "./list/list.command.ts";
import { legacyExperimentalStackLogsCommand } from "./logs/logs.command.ts";
import { legacyExperimentalStackPrepareCommand } from "./prepare/prepare.command.ts";
import { legacyExperimentalStackRestartCommand } from "./restart/restart.command.ts";
import {
  legacyExperimentalStackApiLayer,
  legacyExperimentalStackTargetResolverLayer,
} from "./stack.shared.ts";

/** Shared by the explicit stack commands and config-selected top-level aliases. */
export const legacyExperimentalStackRuntimeLayer = Layer.mergeAll(
  legacyExperimentalStackTargetResolverLayer,
  legacyExperimentalStackApiLayer,
  legacyCliSettingsLayer.pipe(Layer.provide(legacyDebugLoggerLayer)),
);

export const legacyExperimentalStackCommand = Command.make("stack").pipe(
  Command.withDescription("Manage a local Supabase stack with the new backend."),
  Command.withShortDescription("Manage local stacks"),
  Command.withSubcommands([
    legacyExperimentalStackStartCommand,
    legacyExperimentalStackStopCommand,
    legacyExperimentalStackStatusCommand,
    legacyExperimentalStackListCommand,
    legacyExperimentalStackLogsCommand,
    legacyExperimentalStackPrepareCommand,
    legacyExperimentalStackRestartCommand,
  ]),
  Command.provide(legacyExperimentalStackRuntimeLayer),
);
