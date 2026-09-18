import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { dbConnectionLayer } from "../../../command-internal/db-connection.layer.ts";
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
import { stackRestartCommand as stackRestartCommandBase } from "./restart/restart.command.ts";
import { stackPrepareCommand as stackPrepareCommandBase } from "./prepare/prepare.command.ts";
import { stackApiLayer, stackTargetResolverLayer } from "./stack.shared.ts";
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

// Same static `HttpClient`/Management-API-factory requirement as `dbResetRuntimeLayer` in
// `commands/db/reset/reset.layers.ts`; scoped to `start` so sibling stack subcommands don't
// pick up its `--dns-resolver` requirement.
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

const stackStartCommand = stackStartCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "start"])),
  Command.provide(stackStartRuntimeLayer),
);
const stackStopCommand = stackStopCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "stop"])),
);
const stackStatusCommand = stackStatusCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "status"])),
);
const stackDestroyCommand = stackDestroyCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "destroy"])),
);
const stackLogsCommand = stackLogsCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "logs"])),
);
const stackListCommand = stackListCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "list"])),
);
const stackRestartCommand = stackRestartCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "restart"])),
);
const stackPrepareCommand = stackPrepareCommandBase.pipe(
  Command.provide(commandRuntimeLayer(["stack", "prepare"])),
);

export const stackCommand = Command.make("stack").pipe(
  Command.withDescription(
    "Manage an experimental, unstable local Supabase stack with the new backend. This command is excluded from the CLI compatibility promise.",
  ),
  Command.withShortDescription("Manage experimental local stacks"),
  Command.withSubcommands([
    stackDestroyCommand,
    stackListCommand,
    stackLogsCommand,
    stackPrepareCommand,
    stackRestartCommand,
    stackStartCommand,
    stackStatusCommand,
    stackStopCommand,
  ]),
  Command.provide(stackRuntimeLayer),
);
