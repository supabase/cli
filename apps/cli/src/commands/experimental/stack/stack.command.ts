import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { dbConnectionLayer } from "../../../command-internal/db-connection.sql-pg.layer.ts";
import { stackCatalogSetupLayer } from "../../../command-internal/stack-catalog-setup.ts";
import { httpClientLayer } from "../../../auth/http-debug.layer.ts";
import { commandCredentialsLayer } from "../../../auth/command-credentials.layer.ts";
import { commandPlatformApiFactoryLayer } from "../../../auth/command-platform-api-factory.layer.ts";
import { identityStitchLayer } from "../../../command-internal/identity-stitch.ts";
import { stackStartCommand as stackStartCommandBase } from "./start/start.command.ts";
import { stackStopCommand as stackStopCommandBase } from "./stop/stop.command.ts";
import { stackStatusCommand as stackStatusCommandBase } from "./status/status.command.ts";
import { stackDestroyCommand as stackDestroyCommandBase } from "./destroy/destroy.command.ts";
import { stackLogsCommand as stackLogsCommandBase } from "./logs/logs.command.ts";
import { stackListCommand as stackListCommandBase } from "./list/list.command.ts";
import { stackPruneCommand as stackPruneCommandBase } from "./prune/prune.command.ts";
import { stackRestartCommand as stackRestartCommandBase } from "./restart/restart.command.ts";
import { stackInstallCommand as stackInstallCommandBase } from "./install/install.command.ts";
import { stackOutdatedCommand as stackOutdatedCommandBase } from "./outdated/outdated.command.ts";
import { stackUpdateCommand as stackUpdateCommandBase } from "./update/update.command.ts";
import { stackApiLayer, stackTargetResolverLayer } from "../../../command-internal/stack-target.ts";
import { configureLoopbackProxyBypass } from "../../../command-internal/hostname.ts";

const stackCommandSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
const stackTarget = stackTargetResolverLayer.pipe(
  Layer.provideMerge(stackApiLayer),
  Layer.provideMerge(stackCommandSettings),
);
const stackLoopbackProxyLayer = Layer.effectDiscard(
  Effect.sync(() => configureLoopbackProxyBypass()),
);

export const stackRuntimeLayer = Layer.mergeAll(
  stackLoopbackProxyLayer,
  stackTarget,
  dbConnectionLayer,
  stackCatalogSetupLayer,
  telemetryStateLayer,
);

const startCliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
const startHttpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));
const startCredentials = commandCredentialsLayer.pipe(
  Layer.provide(startCliSettings),
  Layer.provide(debugLoggerLayer),
);
const startPlatformApiFactory = commandPlatformApiFactoryLayer.pipe(
  Layer.provide(startCredentials),
  Layer.provide(startCliSettings),
  Layer.provide(debugLoggerLayer),
  Layer.provide(identityStitchLayer),
);
export const stackStartRuntimeLayer = Layer.mergeAll(
  startHttpClient,
  startPlatformApiFactory,
  identityStitchLayer,
);

// Layers sit on each subcommand: a generated command joining this group would bypass a group-level
// `Command.provide` (see src/commands/api/SIDE_EFFECTS.md).
const stackStartCommand = stackStartCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "start"])),
  Command.provide(stackStartRuntimeLayer),
  Command.provide(stackRuntimeLayer),
);
const stackStopCommand = stackStopCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "stop"])),
  Command.provide(stackRuntimeLayer),
);
const stackStatusCommand = stackStatusCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "status"])),
  Command.provide(stackRuntimeLayer),
);
const stackDestroyCommand = stackDestroyCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "destroy"])),
  Command.provide(stackRuntimeLayer),
);
const stackLogsCommand = stackLogsCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "logs"])),
  Command.provide(stackRuntimeLayer),
);
const stackListCommand = stackListCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "list"])),
  Command.provide(stackRuntimeLayer),
);
const stackPruneCommand = stackPruneCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "prune"])),
  Command.provide(stackRuntimeLayer),
);
const stackRestartCommand = stackRestartCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "restart"])),
  Command.provide(stackRuntimeLayer),
);
const stackInstallCommand = stackInstallCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "install"])),
  Command.provide(stackRuntimeLayer),
);
const stackOutdatedCommand = stackOutdatedCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "outdated"])),
  Command.provide(stackRuntimeLayer),
);
const stackUpdateCommand = stackUpdateCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "update"])),
  Command.provide(stackStartRuntimeLayer),
  Command.provide(stackRuntimeLayer),
);

export const stackCommand = Command.make("stack").pipe(
  Command.withDescription(
    "Manage an experimental, unstable local Supabase stack with the new backend. This command is excluded from the CLI compatibility promise.",
  ),
  Command.withShortDescription("Manage experimental local stacks"),
  Command.withSubcommands([
    stackDestroyCommand,
    stackInstallCommand,
    stackListCommand,
    stackLogsCommand,
    stackOutdatedCommand,
    stackPruneCommand,
    stackRestartCommand,
    stackStartCommand,
    stackStatusCommand,
    stackStopCommand,
    stackUpdateCommand,
  ]),
);
